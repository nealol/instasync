//! Offline, checksummed backup and staged restore for every persistent server store.
//!
//! The running server owns an advisory lock beside the application database.
//! Backup creation and restore take the same lock, so their cross-store snapshot
//! is only permitted while the server is stopped. Restore stages every component
//! beside its destination and records a recovery journal before replacing live
//! paths. A server refuses to start while that journal exists.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use fs2::FileExt;
use rusqlite::backup::Backup as SqliteBackup;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqliteConnectOptions;

use crate::config::Config;

const BACKUP_FORMAT: &str = "realtime-full-backup";
const BACKUP_VERSION: u32 = 1;
const RESTORE_JOURNAL_FORMAT: &str = "realtime-restore-journal";
const RESTORE_JOURNAL_VERSION: u32 = 1;
const MANIFEST_FILE: &str = "manifest.json";
const DATA_DIR: &str = "data";
const DATABASE_FILE: &str = "server.sqlite";
const CRDT_DIR: &str = "crdt";
const BLOBS_DIR: &str = "blobs";
const GIT_DIR: &str = "git";
const PLUGIN_DBS_DIR: &str = "plugin-db-replicas";

#[derive(Clone, Debug)]
struct StatePaths {
    database: PathBuf,
    database_wal: PathBuf,
    database_shm: PathBuf,
    database_journal: PathBuf,
    crdt: PathBuf,
    blobs: PathBuf,
    git: PathBuf,
    plugin_dbs: PathBuf,
    lock: PathBuf,
    restore_journal: PathBuf,
}

impl StatePaths {
    fn from_config(config: &Config) -> Result<Self> {
        let database = sqlite_database_path(&config.database_url)?;
        let crdt = absolute_path(Path::new(&config.crdt_store_dir))?;
        let blobs = absolute_path(Path::new(&config.blob_dir))?;
        let git = absolute_path(Path::new(&config.git_data_dir))?;
        let plugin_dbs = git
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(PLUGIN_DBS_DIR);
        let plugin_dbs = absolute_path(&plugin_dbs)?;
        ensure_disjoint(&database, &[&crdt, &blobs, &git, &plugin_dbs])?;
        let lock = appended_path(&database, ".server.lock");
        let restore_journal = appended_path(&database, ".restore.json");
        let database_wal = appended_path(&database, "-wal");
        let database_shm = appended_path(&database, "-shm");
        let database_journal = appended_path(&database, "-journal");
        Ok(Self {
            database,
            database_wal,
            database_shm,
            database_journal,
            crdt,
            blobs,
            git,
            plugin_dbs,
            lock,
            restore_journal,
        })
    }

    fn directory_targets(&self) -> [(&'static str, &Path); 4] {
        [
            (CRDT_DIR, &self.crdt),
            (BLOBS_DIR, &self.blobs),
            (GIT_DIR, &self.git),
            (PLUGIN_DBS_DIR, &self.plugin_dbs),
        ]
    }

    fn live_targets(&self) -> Vec<PathBuf> {
        let mut targets = vec![
            self.database.clone(),
            self.database_wal.clone(),
            self.database_shm.clone(),
            self.database_journal.clone(),
        ];
        targets.extend(
            self.directory_targets()
                .into_iter()
                .map(|(_, path)| path.to_path_buf()),
        );
        targets
    }
}

/// Process-lifetime ownership of the configured server data. The lock file is
/// intentionally retained after unlock; deleting advisory lock files creates a
/// race in which two processes can lock different inodes at the same path.
pub struct InstanceLock {
    _file: File,
    pub path: PathBuf,
}

impl InstanceLock {
    pub fn acquire(config: &Config) -> Result<Self> {
        let paths = StatePaths::from_config(config)?;
        if let Some(parent) = paths.lock.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create lock directory {}", parent.display()))?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&paths.lock)
            .with_context(|| format!("open server lock {}", paths.lock.display()))?;
        file.try_lock_exclusive().map_err(|error| {
            anyhow!(
                "server data is in use (lock {}): {error}; stop the server before backup or restore",
                paths.lock.display()
            )
        })?;
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        writeln!(file, "pid={}", std::process::id())?;
        file.sync_all()?;
        Ok(Self {
            _file: file,
            path: paths.lock,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unix_mode: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupManifest {
    pub format: String,
    pub format_version: u32,
    pub created_at_ms: u64,
    pub server_version: String,
    pub server_id: String,
    pub database_schema_version: i64,
    pub crdt_format: String,
    pub crdt_format_version: u32,
    pub caps: BTreeMap<String, String>,
    pub directories: Vec<String>,
    pub files: Vec<BackupFile>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    pub path: String,
    pub file_count: usize,
    pub bytes: u64,
    pub server_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub source: String,
    pub server_id: String,
    pub restored_components: Vec<String>,
}

/// Refuse startup while an interrupted restore needs recovery. Running the
/// restore command again performs deterministic rollback or committed cleanup.
pub fn ensure_restore_complete(config: &Config) -> Result<()> {
    let paths = StatePaths::from_config(config)?;
    if paths.restore_journal.exists() {
        bail!(
            "incomplete restore journal {}; run `realtime-server backup restore <BACKUP> --force` before starting the server",
            paths.restore_journal.display()
        );
    }
    Ok(())
}

pub async fn create(config: &Config, destination: &Path) -> Result<BackupReport> {
    create_with_failure(config, destination, None).await
}

async fn create_with_failure(
    config: &Config,
    destination: &Path,
    fail_after: Option<usize>,
) -> Result<BackupReport> {
    let _lock = InstanceLock::acquire(config)?;
    ensure_restore_complete(config)?;
    let paths = StatePaths::from_config(config)?;
    if !paths.database.is_file() {
        bail!(
            "application database {} does not exist",
            paths.database.display()
        );
    }
    let destination = absolute_path(destination)?;
    if destination.exists() {
        bail!(
            "backup destination {} already exists",
            destination.display()
        );
    }
    reject_source_overlap(&destination, &paths.live_targets(), "backup destination")?;
    let parent = destination
        .parent()
        .ok_or_else(|| anyhow!("backup destination has no parent"))?;
    fs::create_dir_all(parent)?;
    let stage = sibling_path(
        &destination,
        "backup-tmp",
        &uuid::Uuid::new_v4().to_string(),
    );
    if stage.exists() {
        remove_path(&stage)?;
    }

    let result = async {
        let mut actions = 0usize;
        fs::create_dir(&stage)
            .with_context(|| format!("create backup staging directory {}", stage.display()))?;
        set_private_directory(&stage)?;
        let data = stage.join(DATA_DIR);
        fs::create_dir(&data)?;
        set_private_directory(&data)?;

        snapshot_sqlite(&paths.database, &data.join(DATABASE_FILE))?;
        actions += 1;
        injected_backup_failure(fail_after, actions)?;
        copy_tree_or_empty(&paths.crdt, &data.join(CRDT_DIR))?;
        actions += 1;
        injected_backup_failure(fail_after, actions)?;
        copy_tree_or_empty(&paths.blobs, &data.join(BLOBS_DIR))?;
        actions += 1;
        injected_backup_failure(fail_after, actions)?;
        copy_tree_or_empty(&paths.git, &data.join(GIT_DIR))?;
        actions += 1;
        injected_backup_failure(fail_after, actions)?;
        snapshot_plugin_databases(&paths.plugin_dbs, &data.join(PLUGIN_DBS_DIR))?;
        actions += 1;
        injected_backup_failure(fail_after, actions)?;

        let database_server_id = verify_sqlite(&data.join(DATABASE_FILE), true)?
            .ok_or_else(|| anyhow!("backup database has no persisted server id"))?;
        let database_schema_version = sqlite_user_version(&data.join(DATABASE_FILE))?;
        let crdt_report = crate::crdt_storage::inspect_store(&data.join(CRDT_DIR), false)
            .await
            .context("inspect staged CRDT backup")?;
        if crdt_report.corrupt != 0 {
            bail!(
                "CRDT store contains {} corrupt document(s)",
                crdt_report.corrupt
            );
        }
        let mut files = collect_files(&data, &stage)?;
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let mut directories = collect_directories(&data, &stage)?;
        directories.sort();
        let manifest = BackupManifest {
            format: BACKUP_FORMAT.to_string(),
            format_version: BACKUP_VERSION,
            created_at_ms: now_millis(),
            server_version: env!("CARGO_PKG_VERSION").to_string(),
            server_id: database_server_id,
            database_schema_version,
            crdt_format: crdt_report.format.to_string(),
            crdt_format_version: crdt_report.version,
            caps: crate::caps::caps()
                .into_iter()
                .map(|(name, version)| (name.to_string(), version.to_string()))
                .collect(),
            directories,
            files,
        };
        write_json_atomic(&stage.join(MANIFEST_FILE), &manifest)?;
        actions += 1;
        injected_backup_failure(fail_after, actions)?;
        verify(&stage).await?;
        actions += 1;
        injected_backup_failure(fail_after, actions)?;
        sync_tree(&stage)?;
        fs::rename(&stage, &destination).with_context(|| {
            format!(
                "commit backup {} -> {}",
                stage.display(),
                destination.display()
            )
        })?;
        sync_directory(parent)?;
        let bytes = manifest.files.iter().map(|file| file.bytes).sum();
        Ok(BackupReport {
            path: destination.display().to_string(),
            file_count: manifest.files.len(),
            bytes,
            server_id: manifest.server_id,
        })
    }
    .await;

    if result.is_err() && stage.exists() {
        let _ = remove_path(&stage);
    }
    result
}

fn injected_backup_failure(fail_after: Option<usize>, actions: usize) -> Result<()> {
    if fail_after == Some(actions) {
        bail!("injected backup interruption after filesystem action {actions}");
    }
    Ok(())
}

pub async fn verify(source: &Path) -> Result<BackupManifest> {
    let source = absolute_path(source)?;
    let manifest_path = source.join(MANIFEST_FILE);
    let manifest_bytes = fs::read(&manifest_path)
        .with_context(|| format!("read backup manifest {}", manifest_path.display()))?;
    let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes)
        .with_context(|| format!("decode backup manifest {}", manifest_path.display()))?;
    if manifest.format != BACKUP_FORMAT || manifest.format_version != BACKUP_VERSION {
        bail!(
            "unsupported backup format {:?} version {}",
            manifest.format,
            manifest.format_version
        );
    }
    validate_archive_root(&source)?;
    let data = source.join(DATA_DIR);
    for directory in [CRDT_DIR, BLOBS_DIR, GIT_DIR, PLUGIN_DBS_DIR] {
        if !data.join(directory).is_dir() {
            bail!("backup component data/{directory} is missing");
        }
    }
    if !data.join(DATABASE_FILE).is_file() {
        bail!("backup component data/{DATABASE_FILE} is missing");
    }

    let mut actual = collect_files(&data, &source)?;
    actual.sort_by(|a, b| a.path.cmp(&b.path));
    let mut expected = manifest.files.clone();
    expected.sort_by(|a, b| a.path.cmp(&b.path));
    if actual != expected {
        report_manifest_difference(&expected, &actual)?;
        bail!("backup file inventory does not match its manifest");
    }
    let mut actual_directories = collect_directories(&data, &source)?;
    actual_directories.sort();
    let mut expected_directories = manifest.directories.clone();
    expected_directories.sort();
    if actual_directories != expected_directories {
        bail!("backup directory inventory does not match its manifest");
    }

    let server_id = verify_sqlite(&data.join(DATABASE_FILE), true)?
        .ok_or_else(|| anyhow!("backup database has no persisted server id"))?;
    if server_id != manifest.server_id {
        bail!(
            "backup server id mismatch: manifest {}, database {}",
            manifest.server_id,
            server_id
        );
    }
    let database_schema_version = sqlite_user_version(&data.join(DATABASE_FILE))?;
    if database_schema_version != manifest.database_schema_version {
        bail!(
            "database schema version mismatch: manifest {}, database {}",
            manifest.database_schema_version,
            database_schema_version
        );
    }
    let crdt_report = verify_crdt(&data.join(CRDT_DIR)).await?;
    if crdt_report.format != manifest.crdt_format
        || crdt_report.version != manifest.crdt_format_version
    {
        bail!(
            "CRDT format mismatch: manifest {} v{}, store {} v{}",
            manifest.crdt_format,
            manifest.crdt_format_version,
            crdt_report.format,
            crdt_report.version
        );
    }
    verify_blob_store(&data.join(BLOBS_DIR))?;
    verify_git_store(&data.join(GIT_DIR)).await?;
    verify_plugin_databases(&data.join(PLUGIN_DBS_DIR))?;
    Ok(manifest)
}

pub async fn restore(config: &Config, source: &Path, force: bool) -> Result<RestoreReport> {
    if !force {
        bail!("restore replaces all configured server state; pass --force to continue");
    }
    let _lock = InstanceLock::acquire(config)?;
    let paths = StatePaths::from_config(config)?;
    if paths.restore_journal.exists() {
        recover_restore(&paths)?;
    }
    let source = absolute_path(source)?;
    reject_source_overlap(&source, &paths.live_targets(), "backup source")?;
    let manifest = verify(&source).await?;
    let restore_id = uuid::Uuid::new_v4().to_string();
    let swaps = stage_restore(&source, &paths, &restore_id)?;
    if let Err(error) = verify_staged_restore(&swaps, &manifest).await {
        cleanup_staged_swaps(&swaps)?;
        return Err(error);
    }

    if let Err(error) = install_swaps(&paths.restore_journal, &swaps, None) {
        let recovery = if paths.restore_journal.exists() {
            recover_restore(&paths)
        } else {
            cleanup_staged_swaps(&swaps).map(|()| RestoreRecovery::RolledBack)
        };
        return match recovery {
            Ok(RestoreRecovery::RolledBack) => {
                Err(error.context("restore failed and prior state was restored"))
            }
            Ok(RestoreRecovery::Committed) => Ok(restore_report(&source, &manifest)),
            Err(recovery_error) => Err(anyhow!(
                "restore failed: {error:#}; automatic rollback also failed: {recovery_error:#}"
            )),
        };
    }

    Ok(restore_report(&source, &manifest))
}

fn restore_report(source: &Path, manifest: &BackupManifest) -> RestoreReport {
    RestoreReport {
        source: source.display().to_string(),
        server_id: manifest.server_id.clone(),
        restored_components: vec![
            "database".into(),
            CRDT_DIR.into(),
            BLOBS_DIR.into(),
            GIT_DIR.into(),
            PLUGIN_DBS_DIR.into(),
        ],
    }
}

fn sqlite_database_path(database_url: &str) -> Result<PathBuf> {
    let options = SqliteConnectOptions::from_str(database_url)
        .with_context(|| format!("parse SQLite DATABASE_URL {database_url:?}"))?;
    let path = options.get_filename();
    if path == Path::new(":memory:") || path.to_string_lossy().starts_with("file:sqlx-in-memory-") {
        bail!("full backup requires a file-backed SQLite DATABASE_URL");
    }
    absolute_path(path)
}

fn absolute_path(path: &Path) -> Result<PathBuf> {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new(std::path::MAIN_SEPARATOR_STR)),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    bail!("path {} escapes its filesystem root", path.display());
                }
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    resolve_existing_ancestor(&normalized)
}

/// Canonicalize the longest existing prefix, then append the normalized
/// nonexistent suffix. `canonicalize` on the whole path cannot handle a new
/// backup destination, but lexical comparison alone misses aliases through a
/// symlinked parent.
fn resolve_existing_ancestor(path: &Path) -> Result<PathBuf> {
    let mut ancestor = path.to_path_buf();
    let mut suffix = Vec::new();
    loop {
        match fs::symlink_metadata(&ancestor) {
            Ok(_) => {
                let mut resolved = fs::canonicalize(&ancestor).with_context(|| {
                    format!("resolve existing path ancestor {}", ancestor.display())
                })?;
                for component in suffix.iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let component = ancestor
                    .file_name()
                    .ok_or_else(|| anyhow!("path {} has no existing ancestor", path.display()))?;
                suffix.push(component.to_os_string());
                if !ancestor.pop() {
                    bail!("path {} has no existing ancestor", path.display());
                }
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("inspect path ancestor {}", ancestor.display()));
            }
        }
    }
}

fn ensure_disjoint(database: &Path, directories: &[&Path]) -> Result<()> {
    for directory in directories {
        if database.starts_with(directory) {
            bail!(
                "application database {} must not be inside state directory {}",
                database.display(),
                directory.display()
            );
        }
    }
    for (index, left) in directories.iter().enumerate() {
        for right in directories.iter().skip(index + 1) {
            if left.starts_with(right) || right.starts_with(left) {
                bail!(
                    "persistent state directories overlap: {} and {}",
                    left.display(),
                    right.display()
                );
            }
        }
    }
    Ok(())
}

fn reject_source_overlap(candidate: &Path, live: &[PathBuf], label: &str) -> Result<()> {
    for path in live {
        if candidate == path || candidate.starts_with(path) || path.starts_with(candidate) {
            bail!(
                "{label} {} overlaps live state {}",
                candidate.display(),
                path.display()
            );
        }
    }
    Ok(())
}

fn appended_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value: OsString = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

fn sibling_path(path: &Path, kind: &str, id: &str) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "state".to_string());
    path.with_file_name(format!(".{name}.{kind}-{id}"))
}

fn snapshot_sqlite(source: &Path, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
        set_private_directory(parent)?;
    }
    if destination.exists() {
        remove_path(destination)?;
    }
    let source_connection = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open SQLite source {}", source.display()))?;
    let mut destination_connection = Connection::open(destination)
        .with_context(|| format!("open SQLite backup {}", destination.display()))?;
    {
        let backup = SqliteBackup::new(&source_connection, &mut destination_connection)?;
        backup.run_to_completion(128, Duration::from_millis(10), None)?;
    }
    destination_connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE")
        .with_context(|| format!("checkpoint SQLite backup {}", destination.display()))?;
    drop(destination_connection);
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = appended_path(destination, suffix);
        if sidecar.exists() {
            bail!(
                "SQLite backup left an unexpected sidecar {}",
                sidecar.display()
            );
        }
    }
    set_private_file(destination)?;
    File::open(destination)?.sync_all()?;
    Ok(())
}

fn copy_tree_or_empty(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    set_private_directory(destination)?;
    if !source.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(source)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("state path {} is not a real directory", source.display());
    }
    copy_directory_contents(source, destination)
}

fn copy_directory_contents(source: &Path, destination: &Path) -> Result<()> {
    let mut entries = fs::read_dir(source)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)?;
        if metadata.file_type().is_symlink() {
            bail!(
                "symbolic links are not allowed in backup state: {}",
                source_path.display()
            );
        }
        if metadata.is_dir() {
            fs::create_dir(&destination_path)?;
            fs::set_permissions(&destination_path, metadata.permissions())?;
            copy_directory_contents(&source_path, &destination_path)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &destination_path).with_context(|| {
                format!(
                    "copy {} -> {}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        } else {
            bail!("unsupported state file type: {}", source_path.display());
        }
    }
    Ok(())
}

fn snapshot_plugin_databases(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    set_private_directory(destination)?;
    if !source.exists() {
        return Ok(());
    }
    snapshot_plugin_directory(source, destination)
}

fn snapshot_plugin_directory(source: &Path, destination: &Path) -> Result<()> {
    let mut entries = fs::read_dir(source)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)?;
        if metadata.file_type().is_symlink() {
            bail!(
                "symbolic links are not allowed in plugin replicas: {}",
                source_path.display()
            );
        }
        if metadata.is_dir() {
            fs::create_dir(&destination_path)?;
            set_private_directory(&destination_path)?;
            snapshot_plugin_directory(&source_path, &destination_path)?;
        } else if metadata.is_file() {
            let name = source_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if name.ends_with("-wal") || name.ends_with("-shm") || name.ends_with("-journal") {
                continue;
            }
            if source_path.extension().and_then(|ext| ext.to_str()) == Some("sqlite") {
                snapshot_sqlite(&source_path, &destination_path)?;
            } else {
                bail!(
                    "unexpected file in plugin replica store: {}",
                    source_path.display()
                );
            }
        } else {
            bail!(
                "unsupported plugin replica file type: {}",
                source_path.display()
            );
        }
    }
    Ok(())
}

fn collect_files(root: &Path, relative_to: &Path) -> Result<Vec<BackupFile>> {
    let mut files = Vec::new();
    collect_files_inner(root, relative_to, &mut files)?;
    Ok(files)
}

fn collect_directories(root: &Path, relative_to: &Path) -> Result<Vec<String>> {
    let mut directories = vec![portable_relative_path(root.strip_prefix(relative_to)?)?];
    collect_directories_inner(root, relative_to, &mut directories)?;
    Ok(directories)
}

fn collect_directories_inner(
    root: &Path,
    relative_to: &Path,
    directories: &mut Vec<String>,
) -> Result<()> {
    let mut entries = fs::read_dir(root)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            bail!("symbolic link found in backup: {}", path.display());
        }
        if metadata.is_dir() {
            directories.push(portable_relative_path(path.strip_prefix(relative_to)?)?);
            collect_directories_inner(&path, relative_to, directories)?;
        }
    }
    Ok(())
}

fn collect_files_inner(root: &Path, relative_to: &Path, files: &mut Vec<BackupFile>) -> Result<()> {
    let mut entries = fs::read_dir(root)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            bail!("symbolic link found in backup: {}", path.display());
        }
        if metadata.is_dir() {
            collect_files_inner(&path, relative_to, files)?;
        } else if metadata.is_file() {
            let relative = path.strip_prefix(relative_to)?;
            files.push(BackupFile {
                path: portable_relative_path(relative)?,
                bytes: metadata.len(),
                sha256: sha256_file(&path)?,
                unix_mode: unix_mode(&metadata),
            });
        } else {
            bail!("unsupported file type in backup: {}", path.display());
        }
    }
    Ok(())
}

fn portable_relative_path(path: &Path) -> Result<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(
                value
                    .to_str()
                    .ok_or_else(|| anyhow!("backup path is not UTF-8: {}", path.display()))?,
            ),
            _ => bail!(
                "backup path is not relative and normalized: {}",
                path.display()
            ),
        }
    }
    if parts.is_empty() {
        bail!("empty backup path");
    }
    Ok(parts.join("/"))
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn verify_sqlite(path: &Path, read_server_id: bool) -> Result<Option<String>> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open SQLite database {}", path.display()))?;
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .with_context(|| format!("integrity-check SQLite database {}", path.display()))?;
    if integrity != "ok" {
        bail!(
            "SQLite integrity check failed for {}: {integrity}",
            path.display()
        );
    }
    if !read_server_id {
        return Ok(None);
    }
    let server_id = connection
        .query_row(
            "SELECT value FROM server_meta WHERE key='server_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .with_context(|| format!("read server id from {}", path.display()))?;
    Ok(Some(server_id))
}

fn sqlite_user_version(path: &Path) -> Result<i64> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?
    .query_row("PRAGMA user_version", [], |row| row.get(0))
    .with_context(|| format!("read SQLite schema version from {}", path.display()))
}

async fn verify_crdt(path: &Path) -> Result<crate::crdt_storage::StoreInspection> {
    let report = crate::crdt_storage::inspect_store(path, false)
        .await
        .with_context(|| format!("inspect CRDT store {}", path.display()))?;
    if report.corrupt != 0 {
        bail!("CRDT store contains {} corrupt document(s)", report.corrupt);
    }
    Ok(report)
}

fn verify_blob_store(path: &Path) -> Result<()> {
    for vault in fs::read_dir(path)? {
        let vault = vault?;
        let metadata = fs::symlink_metadata(vault.path())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            bail!("invalid blob vault entry {}", vault.path().display());
        }
        for blob in fs::read_dir(vault.path())? {
            let blob = blob?;
            let blob_path = blob.path();
            let metadata = fs::symlink_metadata(&blob_path)?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                bail!("invalid blob entry {}", blob_path.display());
            }
            let name = blob.file_name().to_string_lossy().into_owned();
            if name.len() != 64
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                bail!(
                    "invalid content-addressed blob name {}",
                    blob_path.display()
                );
            }
            let digest = sha256_file(&blob_path)?;
            if digest != name {
                bail!(
                    "blob digest mismatch for {}: computed {digest}",
                    blob_path.display()
                );
            }
        }
    }
    Ok(())
}

async fn verify_git_store(path: &Path) -> Result<()> {
    let mut repositories = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            bail!(
                "symbolic link found in Git backup: {}",
                entry.path().display()
            );
        }
        if metadata.is_dir() {
            if !entry.path().join(".git").is_dir() {
                bail!(
                    "Git backup directory is not a repository: {}",
                    entry.path().display()
                );
            }
            repositories.push(entry.path());
        } else if metadata.is_file() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".ssh_key") {
                bail!("unexpected file in Git backup: {}", entry.path().display());
            }
        } else {
            bail!(
                "unsupported entry in Git backup: {}",
                entry.path().display()
            );
        }
    }
    repositories.sort();
    for repository in repositories {
        let output = tokio::process::Command::new("git")
            .arg("-C")
            .arg(&repository)
            .args(["fsck", "--full"])
            .output()
            .await
            .with_context(|| format!("run git fsck in {}", repository.display()))?;
        if !output.status.success() {
            bail!(
                "git fsck failed in {}: {}",
                repository.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
    }
    Ok(())
}

fn verify_plugin_databases(root: &Path) -> Result<()> {
    for path in sqlite_files(root)? {
        verify_sqlite(&path, false)?;
    }
    Ok(())
}

fn sqlite_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    sqlite_files_inner(root, &mut out)?;
    out.sort();
    Ok(out)
}

fn sqlite_files_inner(root: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            bail!(
                "symbolic link found in plugin database backup: {}",
                path.display()
            );
        }
        if metadata.is_dir() {
            sqlite_files_inner(&path, out)?;
        } else if metadata.is_file()
            && path.extension().and_then(|extension| extension.to_str()) == Some("sqlite")
        {
            out.push(path);
        }
    }
    Ok(())
}

fn validate_archive_root(source: &Path) -> Result<()> {
    if !source.is_dir() {
        bail!("backup source {} is not a directory", source.display());
    }
    let expected: BTreeSet<&str> = [MANIFEST_FILE, DATA_DIR].into_iter().collect();
    let actual: BTreeSet<String> = fs::read_dir(source)?
        .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
        .collect::<std::io::Result<_>>()?;
    let expected_owned: BTreeSet<String> = expected.into_iter().map(str::to_string).collect();
    if actual != expected_owned {
        bail!("backup root must contain exactly manifest.json and data");
    }
    let manifest_metadata = fs::symlink_metadata(source.join(MANIFEST_FILE))?;
    let data_metadata = fs::symlink_metadata(source.join(DATA_DIR))?;
    if !manifest_metadata.is_file()
        || manifest_metadata.file_type().is_symlink()
        || !data_metadata.is_dir()
        || data_metadata.file_type().is_symlink()
    {
        bail!("backup manifest and data root must not be symbolic links");
    }
    Ok(())
}

fn report_manifest_difference(expected: &[BackupFile], actual: &[BackupFile]) -> Result<()> {
    let expected_paths: BTreeMap<&str, &BackupFile> = expected
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let actual_paths: BTreeMap<&str, &BackupFile> = actual
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    for path in expected_paths.keys() {
        if !actual_paths.contains_key(path) {
            bail!("backup is missing manifest file {path}");
        }
        if expected_paths[path] != actual_paths[path] {
            bail!("backup file differs from manifest: {path}");
        }
    }
    for path in actual_paths.keys() {
        if !expected_paths.contains_key(path) {
            bail!("backup contains unmanifested file {path}");
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreJournal {
    format: String,
    version: u32,
    phase: RestorePhase,
    swaps: Vec<SwapPlan>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RestorePhase {
    Installing,
    Committed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SwapPlan {
    component: String,
    target: PathBuf,
    staged: Option<PathBuf>,
    old: PathBuf,
    had_original: bool,
}

fn stage_restore(source: &Path, paths: &StatePaths, restore_id: &str) -> Result<Vec<SwapPlan>> {
    let data = source.join(DATA_DIR);
    let mut swaps = Vec::with_capacity(8);
    let result = (|| {
        swaps.push(stage_file_component(
            "database",
            &data.join(DATABASE_FILE),
            &paths.database,
            restore_id,
        )?);
        swaps.push(stage_removal_component(
            "database-wal",
            &paths.database_wal,
            restore_id,
        ));
        swaps.push(stage_removal_component(
            "database-shm",
            &paths.database_shm,
            restore_id,
        ));
        swaps.push(stage_removal_component(
            "database-journal",
            &paths.database_journal,
            restore_id,
        ));
        for (name, target) in paths.directory_targets() {
            swaps.push(stage_directory_component(
                name,
                &data.join(name),
                target,
                restore_id,
            )?);
        }
        Ok(())
    })();
    if let Err(error) = result {
        cleanup_staged_swaps(&swaps)?;
        return Err(error);
    }
    Ok(swaps)
}

fn stage_removal_component(component: &str, target: &Path, restore_id: &str) -> SwapPlan {
    SwapPlan {
        component: component.to_string(),
        target: target.to_path_buf(),
        staged: None,
        old: sibling_path(target, "restore-old", restore_id),
        had_original: target.exists(),
    }
}

fn stage_file_component(
    component: &str,
    source: &Path,
    target: &Path,
    restore_id: &str,
) -> Result<SwapPlan> {
    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("restore target {} has no parent", target.display()))?;
    fs::create_dir_all(parent)?;
    let staged = sibling_path(target, "restore-new", restore_id);
    let old = sibling_path(target, "restore-old", restore_id);
    fs::copy(source, &staged)
        .with_context(|| format!("stage restore database {}", staged.display()))?;
    File::open(&staged)?.sync_all()?;
    Ok(SwapPlan {
        component: component.to_string(),
        target: target.to_path_buf(),
        staged: Some(staged),
        old,
        had_original: target.exists(),
    })
}

fn stage_directory_component(
    component: &str,
    source: &Path,
    target: &Path,
    restore_id: &str,
) -> Result<SwapPlan> {
    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("restore target {} has no parent", target.display()))?;
    fs::create_dir_all(parent)?;
    let staged = sibling_path(target, "restore-new", restore_id);
    let old = sibling_path(target, "restore-old", restore_id);
    fs::create_dir(&staged)?;
    set_private_directory(&staged)?;
    copy_directory_contents(source, &staged)?;
    sync_tree(&staged)?;
    Ok(SwapPlan {
        component: component.to_string(),
        target: target.to_path_buf(),
        staged: Some(staged),
        old,
        had_original: target.exists(),
    })
}

async fn verify_staged_restore(swaps: &[SwapPlan], manifest: &BackupManifest) -> Result<()> {
    let database = swap_for(swaps, "database")?;
    let server_id = verify_sqlite(staged_path(database)?, true)?
        .ok_or_else(|| anyhow!("staged database has no server id"))?;
    if server_id != manifest.server_id {
        bail!("staged database server id differs from manifest");
    }
    if sqlite_user_version(staged_path(database)?)? != manifest.database_schema_version {
        bail!("staged database schema version differs from manifest");
    }
    verify_crdt(staged_path(swap_for(swaps, CRDT_DIR)?)?).await?;
    verify_blob_store(staged_path(swap_for(swaps, BLOBS_DIR)?)?)?;
    verify_git_store(staged_path(swap_for(swaps, GIT_DIR)?)?).await?;
    verify_plugin_databases(staged_path(swap_for(swaps, PLUGIN_DBS_DIR)?)?)?;

    let expected: BTreeMap<&str, &BackupFile> = manifest
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    for (path, file) in expected {
        let staged = staged_path_for_archive_path(swaps, path)?;
        let metadata = fs::metadata(&staged)?;
        if metadata.len() != file.bytes || sha256_file(&staged)? != file.sha256 {
            bail!("staged restore file failed verification: {path}");
        }
    }
    Ok(())
}

fn swap_for<'a>(swaps: &'a [SwapPlan], component: &str) -> Result<&'a SwapPlan> {
    swaps
        .iter()
        .find(|swap| swap.component == component)
        .ok_or_else(|| anyhow!("restore plan is missing component {component}"))
}

fn staged_path(swap: &SwapPlan) -> Result<&Path> {
    swap.staged
        .as_deref()
        .ok_or_else(|| anyhow!("restore component {} has no staged payload", swap.component))
}

fn staged_path_for_archive_path(swaps: &[SwapPlan], path: &str) -> Result<PathBuf> {
    let relative = Path::new(path);
    let mut components = relative.components();
    if components.next() != Some(Component::Normal(DATA_DIR.as_ref())) {
        bail!("manifest path is outside data: {path}");
    }
    let component = components
        .next()
        .and_then(|part| match part {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .ok_or_else(|| anyhow!("invalid manifest path {path}"))?;
    if component == DATABASE_FILE {
        if components.next().is_some() {
            bail!("invalid database manifest path {path}");
        }
        return Ok(staged_path(swap_for(swaps, "database")?)?.to_path_buf());
    }
    let swap = swap_for(swaps, component)?;
    let mut staged = staged_path(swap)?.to_path_buf();
    for part in components {
        match part {
            Component::Normal(value) => staged.push(value),
            _ => bail!("invalid manifest path {path}"),
        }
    }
    Ok(staged)
}

fn install_swaps(journal_path: &Path, swaps: &[SwapPlan], fail_after: Option<usize>) -> Result<()> {
    let mut journal = RestoreJournal {
        format: RESTORE_JOURNAL_FORMAT.to_string(),
        version: RESTORE_JOURNAL_VERSION,
        phase: RestorePhase::Installing,
        swaps: swaps.to_vec(),
    };
    write_json_atomic(journal_path, &journal)?;
    let mut actions = 0usize;
    for swap in swaps {
        if swap.old.exists() {
            bail!(
                "restore rollback path already exists: {}",
                swap.old.display()
            );
        }
        if swap.had_original {
            fs::rename(&swap.target, &swap.old)
                .with_context(|| format!("preserve existing {} state", swap.component))?;
            actions += 1;
            injected_failure(fail_after, actions)?;
        }
        if let Some(staged) = &swap.staged {
            fs::rename(staged, &swap.target)
                .with_context(|| format!("install restored {} state", swap.component))?;
            actions += 1;
            injected_failure(fail_after, actions)?;
        }
        if let Some(parent) = swap.target.parent() {
            sync_directory(parent)?;
        }
    }
    journal.phase = RestorePhase::Committed;
    write_json_atomic(journal_path, &journal)?;
    injected_failure(fail_after, actions + 1)?;
    finish_committed_restore(&journal, journal_path)
}

fn injected_failure(fail_after: Option<usize>, actions: usize) -> Result<()> {
    if fail_after == Some(actions) {
        bail!("injected restore interruption after filesystem action {actions}");
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RestoreRecovery {
    RolledBack,
    Committed,
}

fn recover_restore(paths: &StatePaths) -> Result<RestoreRecovery> {
    let bytes = fs::read(&paths.restore_journal)
        .with_context(|| format!("read restore journal {}", paths.restore_journal.display()))?;
    let journal: RestoreJournal = serde_json::from_slice(&bytes)?;
    validate_restore_journal(paths, &journal)?;
    match journal.phase {
        RestorePhase::Installing => {
            rollback_restore(&journal, &paths.restore_journal)?;
            Ok(RestoreRecovery::RolledBack)
        }
        RestorePhase::Committed => {
            finish_committed_restore(&journal, &paths.restore_journal)?;
            Ok(RestoreRecovery::Committed)
        }
    }
}

fn validate_restore_journal(paths: &StatePaths, journal: &RestoreJournal) -> Result<()> {
    if journal.format != RESTORE_JOURNAL_FORMAT || journal.version != RESTORE_JOURNAL_VERSION {
        bail!("unsupported restore journal format");
    }
    let expected: BTreeSet<PathBuf> = paths.live_targets().into_iter().collect();
    let actual: BTreeSet<PathBuf> = journal
        .swaps
        .iter()
        .map(|swap| swap.target.clone())
        .collect();
    if expected != actual || journal.swaps.len() != expected.len() {
        bail!("restore journal targets do not match configured server state");
    }
    for swap in &journal.swaps {
        let parent = swap
            .target
            .parent()
            .ok_or_else(|| anyhow!("journal target has no parent"))?;
        if swap
            .staged
            .as_deref()
            .is_some_and(|staged| staged.parent() != Some(parent))
            || swap.old.parent() != Some(parent)
        {
            bail!("restore journal staging paths are outside their target directory");
        }
    }
    Ok(())
}

fn rollback_restore(journal: &RestoreJournal, journal_path: &Path) -> Result<()> {
    for swap in journal.swaps.iter().rev() {
        if swap.old.exists() {
            if swap.target.exists() {
                remove_path(&swap.target)?;
            }
            fs::rename(&swap.old, &swap.target)
                .with_context(|| format!("restore prior {} state", swap.component))?;
        } else if !swap.had_original
            && swap.target.exists()
            && swap.staged.as_ref().is_some_and(|staged| !staged.exists())
        {
            remove_path(&swap.target)?;
        }
        if let Some(staged) = &swap.staged {
            if staged.exists() {
                remove_path(staged)?;
            }
        }
        if let Some(parent) = swap.target.parent() {
            sync_directory(parent)?;
        }
    }
    fs::remove_file(journal_path)?;
    if let Some(parent) = journal_path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn finish_committed_restore(journal: &RestoreJournal, journal_path: &Path) -> Result<()> {
    for swap in &journal.swaps {
        if swap.old.exists() {
            remove_path(&swap.old)?;
        }
        if let Some(staged) = &swap.staged {
            if staged.exists() {
                remove_path(staged)?;
            }
        }
        if let Some(parent) = swap.target.parent() {
            sync_directory(parent)?;
        }
    }
    fs::remove_file(journal_path)?;
    if let Some(parent) = journal_path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn cleanup_staged_swaps(swaps: &[SwapPlan]) -> Result<()> {
    for swap in swaps {
        if let Some(staged) = &swap.staged {
            if staged.exists() {
                remove_path(staged)?;
            }
        }
    }
    Ok(())
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("JSON path {} has no parent", path.display()))?;
    fs::create_dir_all(parent)?;
    let temp = sibling_path(path, "tmp", &uuid::Uuid::new_v4().to_string());
    let bytes = serde_json::to_vec_pretty(value)?;
    {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        set_private_file(&temp)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&temp, path)?;
    sync_directory(parent)?;
    Ok(())
}

fn sync_tree(path: &Path) -> Result<()> {
    if path.is_dir() {
        for entry in fs::read_dir(path)? {
            sync_tree(&entry?.path())?;
        }
        sync_directory(path)?;
    } else if path.is_file() {
        File::open(path)?.sync_all()?;
    }
    Ok(())
}

fn remove_path(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(unix)]
fn unix_mode(metadata: &fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(metadata.permissions().mode())
}

#[cfg(not(unix))]
fn unix_mode(_metadata: &fs::Metadata) -> Option<u32> {
    None
}

#[cfg(unix)]
fn set_private_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_file(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Doc, GetString, ReadTxn, Text, Transact};

    fn test_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "realtime-full-backup-{name}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    fn test_config(root: &Path) -> Config {
        let mut config = Config::test_default();
        config.database_url = format!("sqlite://{}?mode=rwc", root.join("state.db").display());
        config.crdt_store_dir = root.join(CRDT_DIR).display().to_string();
        config.blob_dir = root.join(BLOBS_DIR).display().to_string();
        config.git_data_dir = root.join(GIT_DIR).display().to_string();
        config.git_enabled = false;
        config
    }

    async fn seed_state(config: &Config, value: &str) {
        let paths = StatePaths::from_config(config).unwrap();
        fs::create_dir_all(paths.database.parent().unwrap()).unwrap();
        let database = Connection::open(&paths.database).unwrap();
        database
            .execute_batch(
                "CREATE TABLE server_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);\
                 CREATE TABLE sentinel (value TEXT NOT NULL);\
                 INSERT INTO server_meta (key,value) VALUES ('server_id','server-fixture');",
            )
            .unwrap();
        database
            .execute("INSERT INTO sentinel (value) VALUES (?1)", [value])
            .unwrap();
        drop(database);

        let documents = crate::crdt::DocumentStore::new(&paths.crdt).await.unwrap();
        let doc = Doc::new();
        let text = doc.get_or_insert_text("contents");
        {
            let mut transaction = doc.transact_mut();
            text.insert(&mut transaction, 0, value);
        }
        let update = doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        documents.apply_update("document", &update).await.unwrap();
        drop(documents);

        let bytes = format!("blob-{value}").into_bytes();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let blob = paths.blobs.join("vault").join(&hash);
        fs::create_dir_all(blob.parent().unwrap()).unwrap();
        fs::write(blob, bytes).unwrap();

        let repository = paths.git.join("vault");
        fs::create_dir_all(&repository).unwrap();
        run_git(&repository, &["init", "-q"]);
        run_git(&repository, &["config", "user.name", "Backup Test"]);
        run_git(
            &repository,
            &["config", "user.email", "backup@example.test"],
        );
        fs::write(repository.join("note.md"), value).unwrap();
        run_git(&repository, &["add", "note.md"]);
        run_git(&repository, &["commit", "-q", "-m", "seed"]);

        let replica = paths
            .plugin_dbs
            .join("vault")
            .join("plugin")
            .join("database.sqlite");
        fs::create_dir_all(replica.parent().unwrap()).unwrap();
        let connection = Connection::open(replica).unwrap();
        connection
            .execute_batch("CREATE TABLE sentinel (value TEXT NOT NULL)")
            .unwrap();
        connection
            .execute("INSERT INTO sentinel (value) VALUES (?1)", [value])
            .unwrap();
    }

    fn run_git(repository: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(repository)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn database_sentinel(config: &Config) -> String {
        let path = sqlite_database_path(&config.database_url).unwrap();
        Connection::open(path)
            .unwrap()
            .query_row("SELECT value FROM sentinel", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn instance_lock_rejects_a_second_owner() {
        let root = test_root("lock");
        fs::create_dir_all(&root).unwrap();
        let config = test_config(&root);
        let first = InstanceLock::acquire(&config).unwrap();
        assert!(InstanceLock::acquire(&config).is_err());
        drop(first);
        InstanceLock::acquire(&config).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn backup_destination_symlinked_into_live_state_is_rejected() {
        use std::os::unix::fs::symlink;

        let root = test_root("symlink-overlap");
        let alias = root.with_extension("live-alias");
        fs::create_dir_all(&root).unwrap();
        let config = test_config(&root);
        seed_state(&config, "original").await;
        let paths = StatePaths::from_config(&config).unwrap();
        symlink(&paths.crdt, &alias).unwrap();

        let destination = alias.join("nested/backup");
        let error = create(&config, &destination).await.unwrap_err();
        assert!(
            error.to_string().contains("overlaps live state"),
            "unexpected error: {error:#}"
        );
        assert!(!paths.crdt.join("nested").exists());

        fs::remove_file(alias).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn complete_backup_round_trips_every_state_store() {
        let root = test_root("roundtrip");
        let backup = root.with_extension("backup");
        fs::create_dir_all(&root).unwrap();
        let config = test_config(&root);
        seed_state(&config, "before").await;

        let report = create(&config, &backup).await.unwrap();
        assert_eq!(report.server_id, "server-fixture");
        let manifest = verify(&backup).await.unwrap();
        assert_eq!(manifest.server_id, "server-fixture");
        assert!(manifest
            .files
            .iter()
            .any(|file| file.path == "data/server.sqlite"));

        let paths = StatePaths::from_config(&config).unwrap();
        let database = Connection::open(&paths.database).unwrap();
        database
            .execute("UPDATE sentinel SET value='after'", [])
            .unwrap();
        drop(database);
        for directory in [&paths.crdt, &paths.blobs, &paths.git, &paths.plugin_dbs] {
            fs::remove_dir_all(directory).unwrap();
            fs::create_dir_all(directory).unwrap();
        }

        let restored = restore(&config, &backup, true).await.unwrap();
        assert_eq!(restored.server_id, "server-fixture");
        assert_eq!(database_sentinel(&config), "before");

        let documents = crate::crdt::DocumentStore::new(&paths.crdt).await.unwrap();
        let update = documents.read_update("document").await.unwrap();
        let restored_doc = Doc::new();
        restored_doc
            .transact_mut()
            .apply_update(crate::safe_yrs::decode_v1::<yrs::Update>(&update).unwrap());
        assert_eq!(
            restored_doc
                .get_or_insert_text("contents")
                .get_string(&restored_doc.transact()),
            "before"
        );

        let blob_files = fs::read_dir(paths.blobs.join("vault"))
            .unwrap()
            .collect::<std::io::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(blob_files.len(), 1);
        assert_eq!(fs::read(blob_files[0].path()).unwrap(), b"blob-before");

        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(paths.git.join("vault"))
            .args(["show", "HEAD:note.md"])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "before");

        let replica = paths.plugin_dbs.join("vault/plugin/database.sqlite");
        let replica_value: String = Connection::open(replica)
            .unwrap()
            .query_row("SELECT value FROM sentinel", [], |row| row.get(0))
            .unwrap();
        assert_eq!(replica_value, "before");

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(backup).unwrap();
    }

    #[tokio::test]
    async fn verification_rejects_tampered_and_unmanifested_content() {
        let root = test_root("tamper");
        let backup = root.with_extension("backup");
        fs::create_dir_all(&root).unwrap();
        let config = test_config(&root);
        seed_state(&config, "original").await;
        create(&config, &backup).await.unwrap();

        let database = backup.join("data/server.sqlite");
        let mut file = OpenOptions::new().append(true).open(database).unwrap();
        file.write_all(b"tamper").unwrap();
        drop(file);
        assert!(verify(&backup)
            .await
            .unwrap_err()
            .to_string()
            .contains("differs from manifest"));

        fs::remove_dir_all(&backup).unwrap();
        create(&config, &backup).await.unwrap();
        let blob = fs::read_dir(backup.join("data/blobs/vault"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::write(&blob, b"forged-content").unwrap();
        let manifest_path = backup.join(MANIFEST_FILE);
        let mut manifest: BackupManifest =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        let relative = portable_relative_path(blob.strip_prefix(&backup).unwrap()).unwrap();
        let record = manifest
            .files
            .iter_mut()
            .find(|file| file.path == relative)
            .unwrap();
        record.bytes = fs::metadata(&blob).unwrap().len();
        record.sha256 = sha256_file(&blob).unwrap();
        write_json_atomic(&manifest_path, &manifest).unwrap();
        assert!(verify(&backup)
            .await
            .unwrap_err()
            .to_string()
            .contains("blob digest mismatch"));

        fs::remove_dir_all(&backup).unwrap();
        create(&config, &backup).await.unwrap();
        fs::create_dir(backup.join("data/unmanifested-empty-directory")).unwrap();
        assert!(verify(&backup)
            .await
            .unwrap_err()
            .to_string()
            .contains("directory inventory"));

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(backup).unwrap();
    }

    #[tokio::test]
    async fn interrupted_backup_never_publishes_a_partial_archive() {
        let root = test_root("backup-fault");
        fs::create_dir_all(&root).unwrap();
        let config = test_config(&root);
        seed_state(&config, "durable").await;

        for fail_after in 1..=7 {
            let destination = root.with_extension(format!("backup-{fail_after}"));
            let error = create_with_failure(&config, &destination, Some(fail_after))
                .await
                .unwrap_err();
            assert!(error.to_string().contains("injected backup interruption"));
            assert!(!destination.exists());
            let stage_prefix = format!(
                ".{}.backup-tmp-",
                destination.file_name().unwrap().to_string_lossy()
            );
            assert!(
                fs::read_dir(destination.parent().unwrap())
                    .unwrap()
                    .all(|entry| !entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with(&stage_prefix)),
                "failed backup left a staging directory"
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn interrupted_restore_rolls_back_each_precommit_swap() {
        let root = test_root("fault");
        let backup = root.with_extension("backup");
        fs::create_dir_all(&root).unwrap();
        let config = test_config(&root);
        seed_state(&config, "backup").await;
        create(&config, &backup).await.unwrap();
        let paths = StatePaths::from_config(&config).unwrap();

        for fail_after in 1..=10 {
            if paths.database.exists() {
                remove_path(&paths.database).unwrap();
            }
            for directory in [&paths.crdt, &paths.blobs, &paths.git, &paths.plugin_dbs] {
                if directory.exists() {
                    remove_path(directory).unwrap();
                }
                fs::create_dir_all(directory).unwrap();
                fs::write(directory.join("old-marker"), b"old").unwrap();
            }
            let database = Connection::open(&paths.database).unwrap();
            database
                .execute_batch(
                    "CREATE TABLE server_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);\
                     CREATE TABLE sentinel (value TEXT NOT NULL);\
                     INSERT INTO server_meta VALUES ('server_id','old-server');\
                     INSERT INTO sentinel VALUES ('old');",
                )
                .unwrap();
            drop(database);

            let swaps = stage_restore(&backup, &paths, &format!("fault-{fail_after}")).unwrap();
            assert!(install_swaps(&paths.restore_journal, &swaps, Some(fail_after)).is_err());
            assert!(paths.restore_journal.exists());
            recover_restore(&paths).unwrap();
            assert_eq!(database_sentinel(&config), "old");
            for directory in [&paths.crdt, &paths.blobs, &paths.git, &paths.plugin_dbs] {
                assert_eq!(fs::read(directory.join("old-marker")).unwrap(), b"old");
            }
        }

        let swaps = stage_restore(&backup, &paths, "committed-fault").unwrap();
        assert!(install_swaps(&paths.restore_journal, &swaps, Some(11)).is_err());
        recover_restore(&paths).unwrap();
        assert_eq!(database_sentinel(&config), "backup");
        assert!(!paths.restore_journal.exists());

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(backup).unwrap();
    }
}
