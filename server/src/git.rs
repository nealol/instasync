//! Per-vault git audit log + backup.
//!
//! Every remote vault gets its own git repository under `config.git_data_dir`,
//! whose working tree mirrors the vault as plain-text markdown. Document writes
//! are coalesced with a debounce (default 5s) into a single commit, **attributed
//! to the authenticated principal** that made them.
//!
//! How attribution works: the auth server is both the minter of every per-user
//! connection token and the reverse proxy in y-sweet's WebSocket data path
//! (`proxy.rs`). When a content write is seen on a connection, the proxy calls
//! [`GitService::mark_write`] with the resolved [`Principal`]. Content itself is
//! pulled authoritatively from y-sweet via `GET /doc/{id}/as-update` (we mint a
//! read-only doc token in-process with the shared key), so the client can never
//! forge file contents — only its own already-authenticated identity.
//!
//! The commit is a full-tree materialization from the *authoritative* CRDT state
//! (the vault index doc's `files` map + each file doc's `contents` text), so
//! creates / edits / deletes / renames all fall out of a single `git add -A`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use sea_orm::{ActiveModelTrait, DatabaseConnection, EntityTrait, Set};
#[cfg(test)]
use serde_json::json;
use serde_json::Value as JsonValue;
use tokio::sync::Mutex;
use y_sweet_core::auth::Authenticator;

use crate::config::Config;
use crate::entities::git_backups;
use crate::plugindb::PluginDbService;
use crate::session::now_millis;
use crate::state::{Principal, PrincipalActor};
use crate::structured::canvas_to_file_json;
use crate::ydoc::{decode_files_map, decode_structured, decode_structured_index, decode_text};

/// A principal seen contributing to a vault during one debounce window.
type Contributor = Principal;

struct VaultState {
    /// A content write has landed since the last commit.
    dirty: bool,
    /// Distinct contributors this window, in first-seen order.
    contributors: Vec<Contributor>,
    /// Commit fires once `Instant::now()` reaches this; pushed out on each write.
    deadline: Instant,
    /// A debounce/commit task is already running for this vault.
    running: bool,
}

struct Inner {
    config: Arc<Config>,
    #[allow(dead_code)]
    http: reqwest::Client,
    db: DatabaseConnection,
    authenticator: Arc<Authenticator>,
    plugindb: PluginDbService,
    vaults: Mutex<HashMap<String, VaultState>>,
}

#[derive(Clone)]
pub struct GitService(Arc<Inner>);

impl GitService {
    pub fn new(
        config: Arc<Config>,
        http: reqwest::Client,
        db: DatabaseConnection,
        authenticator: Arc<Authenticator>,
        plugindb: PluginDbService,
    ) -> Self {
        GitService(Arc::new(Inner {
            config,
            http,
            db,
            authenticator,
            plugindb,
            vaults: Mutex::new(HashMap::new()),
        }))
    }

    fn debounce(&self) -> Duration {
        Duration::from_millis(self.0.config.git_debounce_ms)
    }

    /// Record a content write by `who` to `vault_id` and (re)arm the debounce.
    /// No-op when the audit log is disabled. Cheap and non-blocking.
    pub async fn mark_write(&self, vault_id: &str, who: &Principal) {
        if !self.0.config.git_enabled {
            return;
        }
        let mut vaults = self.0.vaults.lock().await;
        let entry = vaults
            .entry(vault_id.to_string())
            .or_insert_with(|| VaultState {
                dirty: false,
                contributors: Vec::new(),
                deadline: Instant::now(),
                running: false,
            });
        entry.dirty = true;
        let actor_key = who.actor_key();
        if !entry
            .contributors
            .iter()
            .any(|c| c.actor_key() == actor_key)
        {
            entry.contributors.push(who.clone());
        }
        entry.deadline = Instant::now() + self.debounce();
        if !entry.running {
            entry.running = true;
            let svc = self.clone();
            let vault_id = vault_id.to_string();
            tokio::spawn(async move { svc.run_vault(vault_id).await });
        }
    }

    /// Trailing-debounce loop for a single vault. Serializes commits per vault:
    /// only one of these runs at a time per `vault_id` (guarded by `running`).
    async fn run_vault(self, vault_id: String) {
        loop {
            // Wait out the (possibly extended) debounce window.
            loop {
                let remaining = {
                    let vaults = self.0.vaults.lock().await;
                    match vaults.get(&vault_id) {
                        Some(s) => s.deadline.checked_duration_since(Instant::now()),
                        None => return,
                    }
                };
                match remaining {
                    Some(d) => tokio::time::sleep(d).await,
                    None => break, // deadline reached
                }
            }

            // Claim the pending work.
            let contributors = {
                let mut vaults = self.0.vaults.lock().await;
                let Some(s) = vaults.get_mut(&vault_id) else {
                    return;
                };
                if !s.dirty {
                    s.running = false;
                    return;
                }
                s.dirty = false;
                std::mem::take(&mut s.contributors)
            };

            if let Err(e) = self.commit_once(&vault_id, &contributors).await {
                tracing::error!("git audit commit for vault {vault_id} failed: {e:#}");
            }

            // More writes during the commit? Loop and wait again; otherwise stop.
            {
                let mut vaults = self.0.vaults.lock().await;
                let Some(s) = vaults.get_mut(&vault_id) else {
                    return;
                };
                if !s.dirty {
                    s.running = false;
                    return;
                }
            }
        }
    }

    /// Materialize the vault's current state from y-sweet and commit the diff.
    async fn commit_once(&self, vault_id: &str, contributors: &[Contributor]) -> Result<()> {
        let repo = self.ensure_repo(vault_id).await?;

        // 1. Authoritative file set from the vault index doc's `files` map.
        let index_update = self.fetch_as_update(vault_id).await?;
        let files = decode_files_map(&index_update)?; // Vec<(path, guid)>
        let structured = decode_structured_index(&index_update)?;

        // 2. Reconstruct each markdown/structured file from its own doc.
        let mut tree: Vec<(PathBuf, String)> = Vec::with_capacity(files.len() + structured.len());
        for (path, guid) in &files {
            let rel = match safe_rel_path(path) {
                Ok(rel) => rel,
                Err(e) => {
                    tracing::warn!("git audit: skipping unsafe path {path:?}: {e}");
                    continue;
                }
            };
            let doc_id = format!("{vault_id}__{guid}");
            match self.fetch_as_update(&doc_id).await {
                Ok(update) => match decode_text(&update, "contents") {
                    Ok(content) => tree.push((rel, content)),
                    Err(e) => tracing::warn!("git audit: decode {path} failed: {e}"),
                },
                Err(e) => tracing::warn!("git audit: fetch {doc_id} failed: {e}"),
            }
        }
        for entry in &structured {
            let rel = match safe_rel_path(&entry.path) {
                Ok(rel) => rel,
                Err(e) => {
                    tracing::warn!("git audit: skipping unsafe path {:?}: {e}", entry.path);
                    continue;
                }
            };
            let doc_id = format!("{vault_id}__{}", entry.guid);
            match self.fetch_as_update(&doc_id).await {
                Ok(update) => match decode_structured(&update)
                    .and_then(|value| serialize_structured_for_git(&entry.kind, value))
                {
                    Ok(content) => tree.push((rel, content)),
                    Err(e) => tracing::warn!("git audit: decode {} failed: {e}", entry.path),
                },
                Err(e) => tracing::warn!("git audit: fetch {doc_id} failed: {e}"),
            }
        }

        // 2b. Deterministic SQL dumps of synced plugin databases (when the
        // cr-sqlite extension is configured). Purged DBs are excluded, so the
        // prune step in materialize_tree removes their dumps → "deleted" commits.
        for (rel, sql) in self.0.plugindb.dumps_for_vault(vault_id).await {
            tree.push((rel, sql));
        }

        // 3. Write the tree to disk (and prune anything no longer present).
        let repo_for_blocking = repo.clone();
        let tree_for_blocking = tree.clone();
        tokio::task::spawn_blocking(move || {
            materialize_tree(&repo_for_blocking, &tree_for_blocking)
        })
        .await
        .context("materialize task panicked")??;

        // 4. Commit the diff, if any.
        self.commit(&repo, vault_id, contributors).await
    }

    /// Lazily create the vault's repo with a bot identity. Idempotent.
    async fn ensure_repo(&self, vault_id: &str) -> Result<PathBuf> {
        let repo = self.repo_path(vault_id)?;
        if repo.join(".git").is_dir() {
            return Ok(repo);
        }
        tokio::fs::create_dir_all(&repo)
            .await
            .with_context(|| format!("create repo dir {}", repo.display()))?;
        self.git(&repo, &["init", "-q"]).await?;
        self.git(&repo, &["config", "core.autocrlf", "false"])
            .await?;
        self.git(&repo, &["config", "user.name", &self.0.config.git_bot_name])
            .await?;
        self.git(
            &repo,
            &["config", "user.email", &self.0.config.git_bot_email],
        )
        .await?;
        Ok(repo)
    }

    fn repo_path(&self, vault_id: &str) -> Result<PathBuf> {
        // vault_id is a server-issued UUID, but guard against separators regardless.
        if vault_id.is_empty()
            || vault_id.contains('/')
            || vault_id.contains('\\')
            || vault_id.contains("..")
        {
            bail!("invalid vault id");
        }
        Ok(PathBuf::from(&self.0.config.git_data_dir).join(vault_id))
    }

    /// Fetch a document's full state as a Yjs v1 update, authorizing with an
    /// in-process read-only doc token signed by the shared y-sweet key.
    async fn fetch_as_update(&self, doc_id: &str) -> Result<Vec<u8>> {
        crate::ydoc::read_update_with(&self.0.config, &self.0.http, &self.0.authenticator, doc_id)
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))
    }

    /// Stage everything and commit if the working tree actually changed.
    async fn commit(&self, repo: &Path, vault_id: &str, contributors: &[Contributor]) -> Result<()> {
        self.git(repo, &["add", "-A"]).await?;

        // The staged diff drives both the no-op check and the commit subject.
        // `--no-renames` keeps statuses to A/M/D so a rename reads as its two
        // visible effects rather than needing a third phrasing.
        let diff = self
            .git_raw(repo, &["diff", "--cached", "--name-status", "--no-renames"])
            .await?;
        if !diff.status.success() {
            bail!(
                "git diff --cached failed ({}): {}",
                diff.status,
                String::from_utf8_lossy(&diff.stderr).trim()
            );
        }
        let changes = parse_name_status(&String::from_utf8_lossy(&diff.stdout));
        if changes.is_empty() {
            return Ok(()); // nothing changed — idempotent no-op
        }

        let (author, message) =
            build_commit_meta(vault_id, &changes, contributors, &self.0.config);
        // Pin the committer to the Realtime bot via command-scoped (`-c`) config so
        // it never falls back to the server's *global* git identity — regardless of
        // what (if anything) is in global config or whether ensure_repo's local
        // config write ran. The author is the attributed principal (or the bot).
        let committer_name = format!("user.name={}", self.0.config.git_bot_name);
        let committer_email = format!("user.email={}", self.0.config.git_bot_email);
        self.git(
            repo,
            &[
                "-c",
                "commit.gpgsign=false",
                "-c",
                &committer_name,
                "-c",
                &committer_email,
                "commit",
                "--author",
                &author,
                "-m",
                &message,
            ],
        )
        .await?;

        if let Err(e) = self.push(vault_id, repo).await {
            tracing::warn!("git audit: push for vault {vault_id} failed: {e}");
        }
        Ok(())
    }

    /// Push the vault repo to its configured backup remote (if any), recording
    /// the outcome on the `git_backups` row. The remote URL is passed on the
    /// command line each time, so neither it nor any credential ever lands in
    /// the repo's `.git/config`.
    async fn push(&self, vault_id: &str, repo: &Path) -> Result<()> {
        let Some(cfg) = git_backups::Entity::find_by_id(vault_id.to_string())
            .one(&self.0.db)
            .await?
        else {
            return Ok(());
        };
        if !cfg.enabled {
            return Ok(());
        }

        let refspec = format!("HEAD:refs/heads/{}", cfg.branch);
        let remote_url = cfg.remote_url.clone();
        let result = self
            .run_remote_git(vault_id, &cfg, &["push", &remote_url, &refspec], Some(repo))
            .await;

        let mut active: git_backups::ActiveModel = cfg.into();
        match &result {
            Ok(()) => {
                active.last_push_at = Set(Some(now_millis()));
                active.last_push_error = Set(None);
            }
            Err(e) => active.last_push_error = Set(Some(format!("{e:#}"))),
        }
        active.updated_at = Set(now_millis());
        active.update(&self.0.db).await?;
        result
    }

    /// Validate a backup config by listing the remote's refs with the same
    /// credential wiring a real push would use.
    pub async fn test_remote(&self, vault_id: &str, cfg: &git_backups::Model) -> Result<()> {
        let remote_url = cfg.remote_url.clone();
        self.run_remote_git(vault_id, cfg, &["ls-remote", &remote_url, "HEAD"], None)
            .await
    }

    /// Run a credentialed git command against a backup remote. For SSH the
    /// private key is materialized (0600) next to the vault repo and wired via
    /// `GIT_SSH_COMMAND`; for HTTPS the token reaches git through an inline
    /// credential helper reading an env var, so it never appears in argv.
    async fn run_remote_git(
        &self,
        vault_id: &str,
        cfg: &git_backups::Model,
        args: &[&str],
        repo: Option<&Path>,
    ) -> Result<()> {
        let mut cmd = tokio::process::Command::new("git");
        if let Some(repo) = repo {
            cmd.arg("-C").arg(repo);
        }
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        match cfg.auth_method.as_str() {
            "ssh" => {
                let key = cfg
                    .ssh_private_key
                    .as_deref()
                    .context("ssh backup has no private key")?;
                let key_path = self.ssh_key_path(vault_id)?;
                write_private_key(&key_path, key).await?;
                cmd.env(
                    "GIT_SSH_COMMAND",
                    format!(
                        "ssh -i {} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes",
                        shell_quote(&key_path.to_string_lossy())
                    ),
                );
            }
            "https" => {
                let token = cfg
                    .https_token
                    .as_deref()
                    .context("https backup has no token")?;
                cmd.arg("-c").arg(
                    "credential.helper=!f() { echo \"username=x-token\"; echo \"password=$GIT_BACKUP_TOKEN\"; }; f",
                );
                cmd.env("GIT_BACKUP_TOKEN", token);
            }
            // "none": credential-less remotes (file:// paths in tests).
            "none" => {}
            other => bail!("unknown backup auth method {other:?}"),
        }
        cmd.args(args);

        let out = tokio::time::timeout(Duration::from_secs(60), cmd.output())
            .await
            .context("git remote operation timed out")?
            .with_context(|| format!("spawn git {args:?}"))?;
        if !out.status.success() {
            bail!(
                "git {} failed ({}): {}",
                args.first().copied().unwrap_or("?"),
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(())
    }

    fn ssh_key_path(&self, vault_id: &str) -> Result<PathBuf> {
        let repo = self.repo_path(vault_id)?;
        Ok(repo.with_extension("ssh_key"))
    }

    /// Best-effort removal of the materialized SSH key (on backup deletion).
    pub async fn remove_backup_key_file(&self, vault_id: &str) {
        if let Ok(path) = self.ssh_key_path(vault_id) {
            let _ = tokio::fs::remove_file(path).await;
        }
    }

    /// Run `git -C <repo> <args>`, returning an error on non-zero exit.
    async fn git(&self, repo: &Path, args: &[&str]) -> Result<()> {
        let out = self.git_raw(repo, args).await?;
        if !out.status.success() {
            bail!(
                "git {:?} failed ({}): {}",
                args,
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(())
    }

    /// Run `git -C <repo> <args>`, returning the raw output (caller checks status).
    async fn git_raw(&self, repo: &Path, args: &[&str]) -> Result<std::process::Output> {
        tokio::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .await
            .with_context(|| format!("spawn git {args:?}"))
    }
}

/// Generate an ed25519 deploy keypair, returning (private OpenSSH, public OpenSSH).
pub fn generate_ssh_keypair() -> Result<(String, String)> {
    use ssh_key::{Algorithm, LineEnding, PrivateKey};
    let key = PrivateKey::random(&mut rand::rngs::OsRng, Algorithm::Ed25519)
        .context("generate ed25519 key")?;
    let private = key.to_openssh(LineEnding::LF)?.to_string();
    let public = key.public_key().to_openssh()?;
    Ok((private, format!("{public}\n")))
}

/// Write an SSH private key with owner-only permissions (ssh refuses 0644 keys).
async fn write_private_key(path: &Path, key: &str) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::write(path, key)
        .await
        .with_context(|| format!("write ssh key {}", path.display()))?;
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .await
        .with_context(|| format!("chmod ssh key {}", path.display()))?;
    Ok(())
}

/// Single-quote a string for embedding in `GIT_SSH_COMMAND` (parsed by sh).
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// One staged change: git name-status letter (A/M/D) plus the path.
#[derive(Clone, Debug, PartialEq, Eq)]
struct StagedChange {
    status: char,
    path: String,
}

/// Parse `git diff --cached --name-status --no-renames` output (`X\tpath` lines).
fn parse_name_status(output: &str) -> Vec<StagedChange> {
    output
        .lines()
        .filter_map(|line| {
            let (status, path) = line.split_once('\t')?;
            Some(StagedChange {
                status: status.chars().next()?,
                path: path.to_string(),
            })
        })
        .collect()
}

/// Most files listed in a commit subject before falling back to a count.
const SUBJECT_MAX_FILES: usize = 3;

/// Summarize staged changes as a commit subject: a verb matching the change
/// kinds (Add/Update/Delete, "Update" when mixed) plus the paths themselves,
/// or just a count when more than [`SUBJECT_MAX_FILES`] files changed.
fn commit_subject(changes: &[StagedChange]) -> String {
    let verb = match changes.iter().map(|c| c.status).collect::<HashSet<_>>() {
        s if s.len() == 1 => match changes[0].status {
            'A' => "Add",
            'D' => "Delete",
            _ => "Update",
        },
        _ => "Update",
    };
    if changes.len() <= SUBJECT_MAX_FILES {
        let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
        format!("{verb} {}", paths.join(", "))
    } else {
        format!("{verb} {} files", changes.len())
    }
}

/// Build the `--author` value and the commit message (with structured trailers).
fn build_commit_meta(
    vault_id: &str,
    changes: &[StagedChange],
    contributors: &[Contributor],
    config: &Config,
) -> (String, String) {
    let (author_name, author_email) = match contributors.first() {
        Some(p) => author_identity(p, config),
        None => (config.git_bot_name.clone(), config.git_bot_email.clone()),
    };
    let author = format!("{author_name} <{author_email}>");

    let mut message = format!("{}\n\n", commit_subject(changes));
    message.push_str(&format!("Vault-Id: {vault_id}\n"));
    if let Some(p) = contributors.first() {
        append_principal_trailers(&mut message, p);
    }
    for p in contributors.iter().skip(1) {
        let (name, email) = author_identity(p, config);
        message.push_str(&format!("Co-authored-by: {} <{}>\n", name, email));
        append_principal_trailers(&mut message, p);
    }
    (author, message)
}

fn author_identity(principal: &Principal, config: &Config) -> (String, String) {
    match &principal.actor {
        PrincipalActor::User => (principal.display_name.clone(), principal.email.clone()),
        PrincipalActor::Cursor {
            app_id,
            cursor_name,
            ..
        } => (
            cursor_name.clone(),
            format!("cursor+{app_id}@{}", config.cursor_email_domain),
        ),
    }
}

fn append_principal_trailers(message: &mut String, principal: &Principal) {
    match &principal.actor {
        PrincipalActor::User => {
            message.push_str(&format!("Principal-Id: {}\n", principal.user_id));
            message.push_str("Principal-Type: user\n");
        }
        PrincipalActor::Cursor {
            cursor_id,
            cursor_name,
            ..
        } => {
            message.push_str("Principal-Type: cursor\n");
            message.push_str(&format!("Cursor-Id: {cursor_id}\n"));
            message.push_str(&format!("Cursor-Name: {cursor_name}\n"));
            message.push_str(&format!(
                "On-Behalf-Of: {} <{}>\n",
                principal.display_name, principal.email
            ));
            message.push_str(&format!("Authorized-User-Id: {}\n", principal.user_id));
        }
    }
}

/// Validate a vault-relative path and turn it into a safe relative `PathBuf`.
/// Rejects absolute paths, `..`, `.`, empty components, and backslashes.
fn safe_rel_path(path: &str) -> Result<PathBuf> {
    if path.is_empty() || path.contains('\\') {
        bail!("unsafe path {path:?}");
    }
    let mut rel = PathBuf::new();
    for comp in path.split('/') {
        if comp.is_empty() || comp == "." || comp == ".." {
            bail!("unsafe path component in {path:?}");
        }
        rel.push(comp);
    }
    Ok(rel)
}

fn serialize_structured_for_git(kind: &str, value: JsonValue) -> Result<String> {
    match kind {
        "canvas" => Ok(format!(
            "{}\n",
            serde_json::to_string_pretty(&canvas_to_file_json(value))?
        )),
        "base" => Ok(serde_yaml::to_string(&value)?),
        other => bail!("unknown structured document kind {other}"),
    }
}

/// Write every file in `tree` and delete any working-tree file not present in it.
/// Runs on a blocking thread (synchronous fs walk).
fn materialize_tree(repo: &Path, tree: &[(PathBuf, String)]) -> Result<()> {
    let mut desired: HashSet<PathBuf> = HashSet::with_capacity(tree.len());
    for (rel, content) in tree {
        let full = repo.join(rel);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("mkdir {}", parent.display()))?;
        }
        std::fs::write(&full, content).with_context(|| format!("write {}", full.display()))?;
        desired.insert(rel.clone());
    }

    let mut present = Vec::new();
    collect_files(repo, repo, &mut present)?;
    for rel in present {
        if !desired.contains(&rel) {
            let _ = std::fs::remove_file(repo.join(&rel));
        }
    }
    Ok(())
}

/// Collect all file paths (relative to `root`) under `dir`, skipping the top-level `.git`.
fn collect_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in std::fs::read_dir(dir).with_context(|| format!("read_dir {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            if dir == root && entry.file_name() == ".git" {
                continue;
            }
            collect_files(root, &path, out)?;
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_path_buf());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Doc, Map, ReadTxn, Text, Transact};

    fn text_update(name: &str, value: &str) -> Vec<u8> {
        let doc = Doc::new();
        let text = doc.get_or_insert_text(name);
        {
            let mut txn = doc.transact_mut();
            text.insert(&mut txn, 0, value);
        }
        let update = doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        update
    }

    fn files_update(entries: &[(&str, &str)]) -> Vec<u8> {
        let doc = Doc::new();
        let map = doc.get_or_insert_map("files");
        {
            let mut txn = doc.transact_mut();
            for (path, guid) in entries {
                map.insert(&mut txn, path.to_string(), guid.to_string());
            }
        }
        let update = doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        update
    }

    #[test]
    fn decode_text_roundtrips() {
        let update = text_update("contents", "# Hello\nworld");
        assert_eq!(decode_text(&update, "contents").unwrap(), "# Hello\nworld");
    }

    #[test]
    fn decode_files_map_roundtrips() {
        let update = files_update(&[("a.md", "guid-a"), ("dir/b.md", "guid-b")]);
        let mut got = decode_files_map(&update).unwrap();
        got.sort();
        assert_eq!(
            got,
            vec![
                ("a.md".to_string(), "guid-a".to_string()),
                ("dir/b.md".to_string(), "guid-b".to_string()),
            ]
        );
    }

    fn changes(entries: &[(char, &str)]) -> Vec<StagedChange> {
        entries
            .iter()
            .map(|(status, path)| StagedChange {
                status: *status,
                path: path.to_string(),
            })
            .collect()
    }

    #[test]
    fn parses_name_status_output() {
        let parsed = parse_name_status("M\tnote.md\nA\tdir/new.md\nD\told.md\n");
        assert_eq!(
            parsed,
            changes(&[('M', "note.md"), ('A', "dir/new.md"), ('D', "old.md")])
        );
        assert!(parse_name_status("").is_empty());
    }

    #[test]
    fn commit_subject_lists_few_files_with_matching_verb() {
        assert_eq!(commit_subject(&changes(&[('A', "a.md")])), "Add a.md");
        assert_eq!(commit_subject(&changes(&[('D', "a.md")])), "Delete a.md");
        assert_eq!(
            commit_subject(&changes(&[('M', "a.md"), ('M', "dir/b.md")])),
            "Update a.md, dir/b.md"
        );
        // Mixed change kinds fall back to "Update".
        assert_eq!(
            commit_subject(&changes(&[('A', "a.md"), ('D', "b.md")])),
            "Update a.md, b.md"
        );
    }

    #[test]
    fn commit_subject_counts_many_files() {
        assert_eq!(
            commit_subject(&changes(&[
                ('M', "a.md"),
                ('M', "b.md"),
                ('A', "c.md"),
                ('M', "d.md"),
            ])),
            "Update 4 files"
        );
        assert_eq!(
            commit_subject(&changes(&[
                ('A', "a.md"),
                ('A', "b.md"),
                ('A', "c.md"),
                ('A', "d.md"),
            ])),
            "Add 4 files"
        );
    }

    #[test]
    fn generated_keypair_is_valid_openssh() {
        let (private, public) = generate_ssh_keypair().unwrap();
        let parsed = ssh_key::PrivateKey::from_openssh(&private).unwrap();
        let pub_parsed = ssh_key::PublicKey::from_openssh(&public).unwrap();
        assert_eq!(parsed.public_key().key_data(), pub_parsed.key_data());
        assert!(public.starts_with("ssh-ed25519 "));
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("/a/b"), "'/a/b'");
        assert_eq!(shell_quote("a'b"), r"'a'\''b'");
    }

    #[test]
    fn safe_rel_path_rejects_traversal() {
        assert!(safe_rel_path("../etc/passwd").is_err());
        assert!(safe_rel_path("/abs").is_err());
        assert!(safe_rel_path("a/../b").is_err());
        assert!(safe_rel_path("a\\b").is_err());
        assert!(safe_rel_path("").is_err());
        assert_eq!(
            safe_rel_path("a/b.md").unwrap(),
            PathBuf::from("a").join("b.md")
        );
    }

    #[test]
    fn serializes_structured_canvas_for_git() {
        let value = json!({
            "nodes": {
                "n2": { "id": "n2", "type": "text", "text": "second" },
                "n1": { "id": "n1", "type": "text", "text": "first" }
            },
            "edges": {
                "e1": { "id": "e1", "fromNode": "n1", "toNode": "n2" }
            },
            "nodeOrder": ["n1", "n2"],
            "edgeOrder": ["e1"]
        });
        let serialized = serialize_structured_for_git("canvas", value).unwrap();
        assert_eq!(
            serde_json::from_str::<JsonValue>(&serialized).unwrap(),
            json!({
                "nodes": [
                    { "id": "n1", "type": "text", "text": "first" },
                    { "id": "n2", "type": "text", "text": "second" }
                ],
                "edges": [
                    { "id": "e1", "fromNode": "n1", "toNode": "n2" }
                ]
            })
        );
    }

    #[test]
    fn serializes_structured_base_for_git() {
        let serialized =
            serialize_structured_for_git("base", json!({ "views": [{ "type": "table" }] }))
                .unwrap();
        assert!(serialized.contains("views:"));
        assert!(serialized.contains("type: table"));
    }

    #[test]
    fn commit_meta_uses_primary_author_and_coauthors() {
        let config = test_config();
        let contributors = vec![
            Principal {
                user_id: "u1".into(),
                display_name: "Alice".into(),
                email: "a@x".into(),
                actor: PrincipalActor::User,
                expires_at_ms: 0,
            },
            Principal {
                user_id: "u2".into(),
                display_name: "Bob".into(),
                email: "b@x".into(),
                actor: PrincipalActor::User,
                expires_at_ms: 0,
            },
        ];
        let (author, message) = build_commit_meta("v1", &changes(&[('M', "a.md")]), &contributors, &config);
        assert_eq!(author, "Alice <a@x>");
        assert!(message.contains("Principal-Id: u1"));
        assert!(message.contains("Co-authored-by: Bob <b@x>"));
        assert!(!message.contains("Co-authored-by: Alice"));
    }

    #[test]
    fn commit_meta_falls_back_to_bot() {
        let config = test_config();
        let (author, message) = build_commit_meta("v1", &changes(&[('M', "a.md")]), &[], &config);
        assert_eq!(author, "Realtime <realtime@localhost>");
        assert!(!message.contains("Principal-Id"));
    }

    #[test]
    fn commit_meta_attributes_cursor_author_on_behalf_of_user() {
        let config = test_config();
        let contributors = vec![Principal {
            user_id: "u1".into(),
            display_name: "Alice".into(),
            email: "a@x".into(),
            actor: PrincipalActor::Cursor {
                cursor_id: "c1".into(),
                app_id: "app123".into(),
                cursor_name: "Claude".into(),
            },
            expires_at_ms: 0,
        }];

        let (author, message) =
            build_commit_meta("v1", &changes(&[('M', "a.md")]), &contributors, &config);
        assert_eq!(author, "Claude <cursor+app123@localhost>");
        assert!(message.contains("Principal-Type: cursor"));
        assert!(message.contains("Cursor-Id: c1"));
        assert!(message.contains("Cursor-Name: Claude"));
        assert!(message.contains("On-Behalf-Of: Alice <a@x>"));
        assert!(message.contains("Authorized-User-Id: u1"));
    }

    fn test_config() -> Config {
        Config {
            database_url: String::new(),
            bind_addr: String::new(),
            public_base_url: String::new(),
            ysweet_url: String::new(),
            blob_dir: String::new(),
            ysweet_store_dir: None,
            ysweet_public_url: String::new(),
            ysweet_auth_key: String::new(),
            oidc_mode: crate::config::OidcMode::Mock,
            oidc_issuer: None,
            oidc_client_id: None,
            oidc_client_secret: None,
            oidc_redirect_url: None,
            allowed_login_redirects: vec![],
            cors_allowed_origins: vec![],
            git_data_dir: ".".into(),
            git_enabled: true,
            git_debounce_ms: 5000,
            git_bot_name: "Realtime".into(),
            git_bot_email: "realtime@localhost".into(),
            cursor_email_domain: "localhost".into(),
            daily_note_path_template: "Daily Notes/{{YYYY-MM-DD}}.md".into(),
            weekly_note_path_template: None,
            monthly_note_path_template: None,
            quarterly_note_path_template: None,
            yearly_note_path_template: None,
            attachment_fetch_host_allowlist: vec![],
            attachment_allowed_extensions: vec![
                "png".into(),
                "jpg".into(),
                "jpeg".into(),
                "gif".into(),
                "webp".into(),
                "svg".into(),
                "pdf".into(),
                "txt".into(),
            ],
            attachment_max_bytes: crate::blobs::MAX_BLOB_BYTES,
            attachments_path_mode: "relative".into(),
            attachments_subfolder: None,
            upload_token: "test-upload-token".into(),
            crsqlite_ext_path: None,
        }
    }
}
