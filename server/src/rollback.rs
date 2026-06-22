//! Vault rollback: compute the diff between the current authoritative Yjs
//! state and a target git commit's tree, and apply it as *forward* Yjs
//! changes. Git and Yjs history are never rewritten; the result is committed
//! immediately (bypassing the debounce) with a `Rollback to …` subject and a
//! `Rollback-Of:` trailer attributed to the initiating admin.
//!
//! NOTE: rollback is vault-admin only and intentionally bypasses the per-path
//! `authorize_path` checks normal writes go through.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};

use axum::extract::{Path as AxumPath, Query, State};
use axum::Json;
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::git::{sql_dump_parts, CommitOverride};
use crate::history::{self, parse_attachment_shim, parse_ls_tree_z};
use crate::routes::require_admin;
use crate::session::{now_millis, AuthUser};
use crate::state::{AppState, Principal, PrincipalActor};
use crate::ydoc::{
    self, decode_binaries_entries, decode_files_map, decode_structured, decode_structured_index,
    decode_text, IndexOp,
};

/// Bound on concurrent y-sweet document fetches while planning.
const PLAN_FETCH_CONCURRENCY: usize = 8;

// ---------- plan shapes ----------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedChange {
    pub path: String,
    /// markdown | canvas | base | binary
    pub kind: String,
    /// create | modify | delete | restoreBlob
    pub action: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnrecoverableBinary {
    pub path: String,
    pub hash: String,
    /// A binary currently exists at this path and will be left untouched.
    pub current_kept: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDbPlan {
    pub plugin: String,
    pub name: String,
    pub changed: bool,
    pub rollbackable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackPlan {
    pub target_commit: String,
    pub changes: Vec<PlannedChange>,
    pub unrecoverable_binaries: Vec<UnrecoverableBinary>,
    pub plugin_dbs: Vec<PluginDbPlan>,
}

/// Concrete work the executor applies (planner output, not serialized).
enum PlannedOp {
    SetText {
        path: String,
        /// Existing doc guid, or None to create.
        guid: Option<String>,
        content: String,
    },
    SetStructured {
        path: String,
        guid: Option<String>,
        kind: String,
        value: JsonValue,
    },
    SetBinary {
        path: String,
        hash: String,
        size: u64,
        /// Bytes recovered from git to re-insert into the blob store.
        blob_bytes: Option<Vec<u8>>,
    },
    RemoveFile {
        path: String,
    },
    RemoveStructured {
        path: String,
    },
    RemoveBinary {
        path: String,
    },
}

struct Plan {
    summary: RollbackPlan,
    ops: Vec<PlannedOp>,
    /// (plugin, name, target dump sql) for rollbackable plugin DBs.
    plugin_targets: Vec<(String, String, String)>,
}

// ---------- planner ----------

async fn plan_rollback(state: &AppState, vault_id: &str, hash: &str) -> AppResult<Plan> {
    let full = history::resolve_commit(state, vault_id, hash).await?;

    // Target tree.
    let out = state
        .git
        .git_output(vault_id, &["ls-tree", "-r", "-l", "-z", &full])
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if !out.status.success() {
        return Err(AppError::NotFound);
    }
    let tree = parse_ls_tree_z(&out.stdout);

    // Current authoritative state (Yjs, not HEAD — git lags the debounce).
    let index_update = ydoc::read_update(state, vault_id).await?;
    let files: HashMap<String, String> = decode_files_map(&index_update)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .into_iter()
        .collect();
    let structured: HashMap<String, (String, String)> = decode_structured_index(&index_update)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .into_iter()
        .map(|e| (e.path, (e.guid, e.kind)))
        .collect();
    let binaries: HashMap<String, (String, u64)> = decode_binaries_entries(&index_update)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .into_iter()
        .map(|e| (e.path, (e.hash, e.size)))
        .collect();

    let mut changes = Vec::new();
    let mut unrecoverable = Vec::new();
    let mut plugin_paths: Vec<(String, String, String)> = Vec::new(); // plugin, name, path
    let mut target_paths: HashSet<String> = HashSet::new();
    let mut skip_delete: HashSet<String> = HashSet::new();

    // Per-path planning, with bounded fetch concurrency.
    enum Classified {
        Markdown,
        Structured(String),
        Binary,
    }
    let mut jobs = Vec::new();
    for entry in &tree {
        let path = entry.path.clone();
        if let Some((plugin, name)) = sql_dump_parts(&path) {
            plugin_paths.push((plugin.to_string(), name.to_string(), path.clone()));
            continue;
        }
        target_paths.insert(path.clone());
        let class = if files.contains_key(&path) {
            Classified::Markdown
        } else if let Some((_, kind)) = structured.get(&path) {
            Classified::Structured(kind.clone())
        } else if binaries.contains_key(&path) {
            Classified::Binary
        } else {
            // Create: classify by extension (VaultSync only syncs these kinds).
            match history::path_kind(&path) {
                "markdown" => Classified::Markdown,
                "canvas" => Classified::Structured("canvas".into()),
                "base" => Classified::Structured("base".into()),
                _ => Classified::Binary,
            }
        };
        jobs.push((path, class));
    }

    let results = stream::iter(jobs.into_iter().map(|(path, class)| {
        let files = &files;
        let structured = &structured;
        let binaries = &binaries;
        let full = full.clone();
        async move {
            let bytes = history::file_bytes_at(state, vault_id, &full, &path).await?;
            let Some(bytes) = bytes else {
                return Ok::<_, AppError>(None);
            };
            match class {
                Classified::Markdown => {
                    let content = String::from_utf8_lossy(&bytes).to_string();
                    match files.get(&path) {
                        Some(guid) => {
                            let doc_id = format!("{vault_id}__{guid}");
                            let update = ydoc::read_update(state, &doc_id).await?;
                            let current = decode_text(&update, "contents")
                                .map_err(|e| AppError::Internal(e.to_string()))?;
                            if current == content {
                                return Ok(None);
                            }
                            Ok(Some(PlannedOp::SetText {
                                path,
                                guid: Some(guid.clone()),
                                content,
                            }))
                        }
                        None => Ok(Some(PlannedOp::SetText {
                            path,
                            guid: None,
                            content,
                        })),
                    }
                }
                Classified::Structured(kind) => {
                    let value = match kind.as_str() {
                        "canvas" => {
                            let file: JsonValue = serde_json::from_slice(&bytes).map_err(|e| {
                                AppError::Internal(format!("parse canvas {path}: {e}"))
                            })?;
                            crate::structured::canvas_file_to_map(file)
                        }
                        _ => {
                            let yaml: serde_yaml::Value =
                                serde_yaml::from_slice(&bytes).map_err(|e| {
                                    AppError::Internal(format!("parse base {path}: {e}"))
                                })?;
                            serde_json::to_value(yaml)
                                .map_err(|e| AppError::Internal(e.to_string()))?
                        }
                    };
                    match structured.get(&path) {
                        Some((guid, _)) => {
                            let doc_id = format!("{vault_id}__{guid}");
                            let update = ydoc::read_update(state, &doc_id).await?;
                            let current = decode_structured(&update)
                                .map_err(|e| AppError::Internal(e.to_string()))?;
                            if current == value {
                                return Ok(None);
                            }
                            Ok(Some(PlannedOp::SetStructured {
                                path,
                                guid: Some(guid.clone()),
                                kind,
                                value,
                            }))
                        }
                        None => Ok(Some(PlannedOp::SetStructured {
                            path,
                            guid: None,
                            kind,
                            value,
                        })),
                    }
                }
                Classified::Binary => {
                    let (hash, size, blob_bytes, blob_missing) = match parse_attachment_shim(&bytes)
                    {
                        Some(shim) => {
                            let available = blob_exists(state, vault_id, &shim.hash);
                            (shim.hash, shim.size, None, !available)
                        }
                        None => {
                            let hash = sha256_hex(&bytes);
                            let size = bytes.len() as u64;
                            let missing = !blob_exists(state, vault_id, &hash);
                            let blob_bytes = missing.then(|| bytes.clone());
                            (hash, size, blob_bytes, false)
                        }
                    };
                    if blob_missing {
                        // Shim + blob GC'd: unrecoverable. Leave any current
                        // file at this path untouched.
                        return Ok(Some(PlannedOp::SetBinary {
                            path,
                            hash,
                            size: u64::MAX, // sentinel; filtered below
                            blob_bytes: None,
                        }));
                    }
                    match binaries.get(&path) {
                        Some((cur_hash, _)) if *cur_hash == hash && blob_bytes.is_none() => {
                            Ok(None)
                        }
                        _ => Ok(Some(PlannedOp::SetBinary {
                            path,
                            hash,
                            size,
                            blob_bytes,
                        })),
                    }
                }
            }
        }
    }))
    .buffer_unordered(PLAN_FETCH_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;

    let mut ops = Vec::new();
    for res in results {
        match res? {
            None => {}
            Some(PlannedOp::SetBinary {
                path, hash, size, ..
            }) if size == u64::MAX => {
                let current_kept = binaries.contains_key(&path);
                if current_kept {
                    skip_delete.insert(path.clone());
                }
                unrecoverable.push(UnrecoverableBinary {
                    path,
                    hash,
                    current_kept,
                });
            }
            Some(op) => {
                let (path, kind, action) = match &op {
                    PlannedOp::SetText { path, guid, .. } => (
                        path.clone(),
                        "markdown",
                        if guid.is_some() { "modify" } else { "create" },
                    ),
                    PlannedOp::SetStructured {
                        path, guid, kind, ..
                    } => (
                        path.clone(),
                        if kind == "canvas" { "canvas" } else { "base" },
                        if guid.is_some() { "modify" } else { "create" },
                    ),
                    PlannedOp::SetBinary {
                        path, blob_bytes, ..
                    } => (
                        path.clone(),
                        "binary",
                        if blob_bytes.is_some() {
                            "restoreBlob"
                        } else if binaries.contains_key(path) {
                            "modify"
                        } else {
                            "create"
                        },
                    ),
                    _ => unreachable!(),
                };
                changes.push(PlannedChange {
                    path,
                    kind: kind.to_string(),
                    action: action.to_string(),
                });
                ops.push(op);
            }
        }
    }

    // Deletes: every current path absent from the target tree (lands in the
    // recoverable `trash` map), excluding leave-in-place unrecoverables.
    for path in files.keys() {
        if !target_paths.contains(path) && !skip_delete.contains(path) {
            changes.push(PlannedChange {
                path: path.clone(),
                kind: "markdown".into(),
                action: "delete".into(),
            });
            ops.push(PlannedOp::RemoveFile { path: path.clone() });
        }
    }
    for (path, (_, kind)) in &structured {
        if !target_paths.contains(path) && !skip_delete.contains(path) {
            changes.push(PlannedChange {
                path: path.clone(),
                kind: kind.clone(),
                action: "delete".into(),
            });
            ops.push(PlannedOp::RemoveStructured { path: path.clone() });
        }
    }
    for path in binaries.keys() {
        if !target_paths.contains(path) && !skip_delete.contains(path) {
            changes.push(PlannedChange {
                path: path.clone(),
                kind: "binary".into(),
                action: "delete".into(),
            });
            ops.push(PlannedOp::RemoveBinary { path: path.clone() });
        }
    }

    // Plugin databases: target dumps vs current replica dumps.
    let current_dumps: HashMap<String, String> = state
        .plugindb
        .dumps_for_vault(vault_id)
        .await
        .into_iter()
        .map(|(rel, sql)| (rel.to_string_lossy().replace('\\', "/"), sql))
        .collect();
    let mut plugin_dbs = Vec::new();
    let mut plugin_targets = Vec::new();
    for (plugin, name, path) in &plugin_paths {
        let Some(bytes) = history::file_bytes_at(state, vault_id, &full, path).await? else {
            continue;
        };
        let target_sql = String::from_utf8_lossy(&bytes).to_string();
        let changed = current_dumps
            .get(path)
            .map(|s| s != &target_sql)
            .unwrap_or(true);
        let (rollbackable, reason) = if !changed {
            (false, Some("already at this state".to_string()))
        } else {
            state
                .plugindb
                .rollback_check(vault_id, plugin, name, &target_sql)
                .await
        };
        if rollbackable {
            plugin_targets.push((plugin.clone(), name.clone(), target_sql));
        }
        plugin_dbs.push(PluginDbPlan {
            plugin: plugin.clone(),
            name: name.clone(),
            changed,
            rollbackable,
            reason,
        });
    }

    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Plan {
        summary: RollbackPlan {
            target_commit: full,
            changes,
            unrecoverable_binaries: unrecoverable,
            plugin_dbs,
        },
        ops,
        plugin_targets,
    })
}

fn blob_exists(state: &AppState, vault_id: &str, hash: &str) -> bool {
    crate::blobs::blob_fs_path(&state.config.blob_dir, vault_id, hash)
        .map(|p| p.exists())
        .unwrap_or(false)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

// ---------- executor ----------

/// Per-vault advisory locks so two rollbacks never interleave.
fn rollback_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RollbackBody {
    #[serde(default)]
    pub plugin_dbs: Vec<PluginDbSelector>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginDbSelector {
    pub plugin: String,
    pub name: String,
}

/// Optional query params for the rollback endpoints.
///
/// - `path`: the current authoritative vault path to mutate. When present,
///   the rollback is scoped to this single path.
/// - `targetPath`: the path to read from the target commit's tree. Defaults to
///   `path` when omitted. Required to differ from `path` for cross-rename
///   rollback (e.g. `path=new.md&targetPath=old.md`).
///
/// If `targetPath` is present and `path` is absent, the request is rejected
/// with a 400 (`targetPath requires path`).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RollbackQuery {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default, rename = "targetPath")]
    pub target_path: Option<String>,
}

/// Validate the rollback query and return `Some((path, target_path))` when
/// this is a single-file rollback, or `None` for a full vault rollback.
fn validate_rollback_query(q: &RollbackQuery) -> AppResult<Option<(String, String)>> {
    let Some(path) = q.path.as_ref() else {
        if q.target_path.is_some() {
            return Err(AppError::BadRequest("targetPath requires path".into()));
        }
        return Ok(None);
    };
    let path = history::validated_rel_path(path)?;
    let target_path = match q.target_path.as_ref() {
        Some(tp) => history::validated_rel_path(tp)?,
        None => path.clone(),
    };
    Ok(Some((path, target_path)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackResult {
    /// The new "Rollback to …" commit, when anything changed.
    pub commit: Option<String>,
    pub applied: usize,
    pub deleted: usize,
    pub blobs_restored: usize,
    pub plugin_dbs_rolled_back: usize,
    pub unrecoverable_binaries: Vec<UnrecoverableBinary>,
}

async fn execute_rollback(
    state: &AppState,
    principal: &Principal,
    vault_id: &str,
    hash: &str,
    selected_dbs: &[PluginDbSelector],
    single_file: Option<(String, String)>,
) -> AppResult<RollbackResult> {
    let lock = {
        let mut locks = rollback_locks().lock().await;
        locks
            .entry(vault_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = lock.lock().await;

    // Recompute fresh — the preview was advisory.
    let plan = match &single_file {
        Some((path, target_path)) => {
            plan_single_file_rollback(state, vault_id, hash, path, target_path).await?
        }
        None => plan_rollback(state, vault_id, hash).await?,
    };
    let full = plan.summary.target_commit.clone();

    let mut applied = 0usize;
    let mut deleted = 0usize;
    let mut blobs_restored = 0usize;
    let mut index_ops: Vec<IndexOp> = Vec::new();

    for op in &plan.ops {
        match op {
            PlannedOp::SetText {
                path,
                guid,
                content,
            } => {
                let guid = match guid {
                    Some(guid) => guid.clone(),
                    None => {
                        let guid = uuid::Uuid::new_v4().to_string();
                        index_ops.push(IndexOp::SetFile {
                            path: path.clone(),
                            guid: guid.clone(),
                        });
                        guid
                    }
                };
                let doc_id = format!("{vault_id}__{guid}");
                crate::ysweet::ensure_doc(state, &doc_id).await?;
                ydoc::set_text(state, &doc_id, content).await?;
                applied += 1;
            }
            PlannedOp::SetStructured {
                path,
                guid,
                kind,
                value,
            } => {
                let guid = match guid {
                    Some(guid) => guid.clone(),
                    None => {
                        let guid = uuid::Uuid::new_v4().to_string();
                        index_ops.push(IndexOp::SetStructured {
                            path: path.clone(),
                            guid: guid.clone(),
                            kind: kind.clone(),
                        });
                        guid
                    }
                };
                let doc_id = format!("{vault_id}__{guid}");
                crate::ysweet::ensure_doc(state, &doc_id).await?;
                ydoc::set_structured(state, &doc_id, value).await?;
                applied += 1;
            }
            PlannedOp::SetBinary {
                path,
                hash,
                size,
                blob_bytes,
            } => {
                if let Some(bytes) = blob_bytes {
                    let fs_path =
                        crate::blobs::blob_fs_path(&state.config.blob_dir, vault_id, hash)
                            .map_err(AppError::BadRequest)?;
                    if sha256_hex(bytes) != *hash {
                        return Err(AppError::Internal(format!(
                            "recovered bytes for {path} do not hash to {hash}"
                        )));
                    }
                    if let Some(parent) = fs_path.parent() {
                        tokio::fs::create_dir_all(parent)
                            .await
                            .map_err(|e| AppError::Internal(format!("blob mkdir: {e}")))?;
                    }
                    tokio::fs::write(&fs_path, bytes)
                        .await
                        .map_err(|e| AppError::Internal(format!("blob restore: {e}")))?;
                    blobs_restored += 1;
                }
                index_ops.push(IndexOp::SetBinary {
                    path: path.clone(),
                    hash: hash.clone(),
                    size: *size as i64,
                });
                applied += 1;
            }
            PlannedOp::RemoveFile { path } => {
                index_ops.push(IndexOp::RemoveFile { path: path.clone() });
                deleted += 1;
            }
            PlannedOp::RemoveStructured { path } => {
                index_ops.push(IndexOp::RemoveStructured { path: path.clone() });
                deleted += 1;
            }
            PlannedOp::RemoveBinary { path } => {
                index_ops.push(IndexOp::RemoveBinary { path: path.clone() });
                deleted += 1;
            }
        }
    }

    // One index transaction for every map mutation + trash entry.
    ydoc::index_apply_batch(state, vault_id, &index_ops).await?;

    // Mirror the search index (full reindex keeps this simple and correct).
    if applied + deleted > 0 {
        if let Err(e) = crate::search::reindex_vault(state, vault_id).await {
            tracing::warn!("rollback: search reindex for {vault_id} failed: {e}");
        }
    }

    // Selected plugin DBs, validated against the freshly computed plan.
    let mut plugin_dbs_rolled_back = 0usize;
    for sel in selected_dbs {
        let Some((plugin, name, sql)) = plan
            .plugin_targets
            .iter()
            .find(|(p, n, _)| *p == sel.plugin && *n == sel.name)
        else {
            return Err(AppError::BadRequest(format!(
                "plugin db {}/{} is not rollbackable for this commit",
                sel.plugin, sel.name
            )));
        };
        state
            .plugindb
            .rollback_to_dump(vault_id, plugin, name, sql)
            .await
            .map_err(|e| AppError::Internal(format!("plugin db rollback: {e:#}")))?;
        state.plugindb.mark_write(vault_id, plugin, name).await;
        plugin_dbs_rolled_back += 1;
    }

    // Immediate, awaited commit so a user edit can't coalesce into it.
    let mut commit = None;
    if applied + deleted + plugin_dbs_rolled_back > 0 {
        let subject = match &single_file {
            Some((path, _)) => rollback_subject_path(state, vault_id, &full, path).await,
            None => rollback_subject(state, vault_id, &full).await,
        };
        let ov = CommitOverride {
            subject,
            trailers: vec![("Rollback-Of".to_string(), full.clone())],
        };
        commit = state
            .git
            .commit_now(vault_id, principal, ov)
            .await
            .map_err(|e| AppError::Internal(format!("rollback commit: {e:#}")))?;
    }

    Ok(RollbackResult {
        commit,
        applied,
        deleted,
        blobs_restored,
        plugin_dbs_rolled_back,
        unrecoverable_binaries: plan.summary.unrecoverable_binaries,
    })
}

/// `Rollback to {short} ({YYYY-MM-DD HH:MM})` from the target's author date.
async fn rollback_subject(state: &AppState, vault_id: &str, full: &str) -> String {
    let short: String = full.chars().take(10).collect();
    let when = state
        .git
        .git_output(vault_id, &["log", "-n1", "--format=%at", full])
        .await
        .ok()
        .and_then(|out| {
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse::<i64>()
                .ok()
        })
        .and_then(|secs| chrono::DateTime::from_timestamp(secs, 0))
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string());
    match when {
        Some(when) => format!("Rollback to {short} ({when})"),
        None => format!("Rollback to {short}"),
    }
}

/// `Rollback {path} to {short} ({YYYY-MM-DD HH:MM})` for single-file rollback.
async fn rollback_subject_path(state: &AppState, vault_id: &str, full: &str, path: &str) -> String {
    let short: String = full.chars().take(10).collect();
    let when = state
        .git
        .git_output(vault_id, &["log", "-n1", "--format=%at", full])
        .await
        .ok()
        .and_then(|out| {
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse::<i64>()
                .ok()
        })
        .and_then(|secs| chrono::DateTime::from_timestamp(secs, 0))
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string());
    match when {
        Some(when) => format!("Rollback {path} to {short} ({when})"),
        None => format!("Rollback {path} to {short}"),
    }
}

// ---------- single-file rollback ----------

/// Plan a single-file rollback: restore `path` (current vault path) to the
/// content of `target_path` at commit `hash`. `target_path` defaults to
/// `path` when equal. Plugin DBs are never touched by single-file rollback.
///
/// Classification:
/// - If `path` currently exists, classify by the current index kind. If the
///   target content's extension-implied kind differs from the current kind,
///   reject with a 400 — single-file rollback refuses to convert a path's
///   kind. Users can use full vault rollback for broader state restoration.
/// - If `path` is currently absent, classify by `target_path`'s extension
///   (matches full rollback's create-path classification).
async fn plan_single_file_rollback(
    state: &AppState,
    vault_id: &str,
    hash: &str,
    path: &str,
    target_path: &str,
) -> AppResult<Plan> {
    let full = history::resolve_commit(state, vault_id, hash).await?;

    // Current authoritative state (Yjs, not HEAD — git lags the debounce).
    let index_update = ydoc::read_update(state, vault_id).await?;
    let files: HashMap<String, String> = decode_files_map(&index_update)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .into_iter()
        .collect();
    let structured: HashMap<String, (String, String)> = decode_structured_index(&index_update)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .into_iter()
        .map(|e| (e.path, (e.guid, e.kind)))
        .collect();
    let binaries: HashMap<String, (String, u64)> = decode_binaries_entries(&index_update)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .into_iter()
        .map(|e| (e.path, (e.hash, e.size)))
        .collect();

    let mut changes = Vec::new();
    let mut unrecoverable = Vec::new();
    let mut ops = Vec::new();

    let target_bytes = history::file_bytes_at(state, vault_id, &full, target_path).await?;

    if let Some(bytes) = target_bytes {
        // Target present: classify by current state first.
        if let Some(guid) = files.get(path) {
            // Current path is markdown. Target must be markdown.
            let target_kind = history::path_kind(target_path);
            if target_kind != "markdown" {
                return Err(AppError::BadRequest(format!(
                    "rollback would change file kind for {path}; use full vault rollback"
                )));
            }
            let content = String::from_utf8_lossy(&bytes).to_string();
            let doc_id = format!("{vault_id}__{guid}");
            let update = ydoc::read_update(state, &doc_id).await?;
            let current =
                decode_text(&update, "contents").map_err(|e| AppError::Internal(e.to_string()))?;
            if current != content {
                changes.push(PlannedChange {
                    path: path.to_string(),
                    kind: "markdown".into(),
                    action: "modify".into(),
                });
                ops.push(PlannedOp::SetText {
                    path: path.to_string(),
                    guid: Some(guid.clone()),
                    content,
                });
            }
        } else if let Some((guid, kind)) = structured.get(path) {
            // Current path is structured. Target must be the same kind.
            let target_kind = history::path_kind(target_path);
            if target_kind != kind.as_str() {
                return Err(AppError::BadRequest(format!(
                    "rollback would change file kind for {path}; use full vault rollback"
                )));
            }
            let value = match kind.as_str() {
                "canvas" => {
                    let file: JsonValue = serde_json::from_slice(&bytes).map_err(|e| {
                        AppError::Internal(format!("parse canvas {target_path}: {e}"))
                    })?;
                    crate::structured::canvas_file_to_map(file)
                }
                _ => {
                    let yaml: serde_yaml::Value = serde_yaml::from_slice(&bytes).map_err(|e| {
                        AppError::Internal(format!("parse base {target_path}: {e}"))
                    })?;
                    serde_json::to_value(yaml).map_err(|e| AppError::Internal(e.to_string()))?
                }
            };
            let doc_id = format!("{vault_id}__{guid}");
            let update = ydoc::read_update(state, &doc_id).await?;
            let current =
                decode_structured(&update).map_err(|e| AppError::Internal(e.to_string()))?;
            if current != value {
                changes.push(PlannedChange {
                    path: path.to_string(),
                    kind: kind.clone(),
                    action: "modify".into(),
                });
                ops.push(PlannedOp::SetStructured {
                    path: path.to_string(),
                    guid: Some(guid.clone()),
                    kind: kind.clone(),
                    value,
                });
            }
        } else if let Some((cur_hash, _)) = binaries.get(path) {
            // Current path is binary. Target must be binary (any non-md/
            // canvas/base extension is binary by path_kind).
            let (hash, size, blob_bytes, blob_missing) = match parse_attachment_shim(&bytes) {
                Some(shim) => {
                    let available = blob_exists(state, vault_id, &shim.hash);
                    (shim.hash, shim.size, None, !available)
                }
                None => {
                    let hash = sha256_hex(&bytes);
                    let size = bytes.len() as u64;
                    let missing = !blob_exists(state, vault_id, &hash);
                    let blob_bytes = missing.then(|| bytes.clone());
                    (hash, size, blob_bytes, false)
                }
            };
            if blob_missing {
                // Unrecoverable: leave the current file at `path` untouched.
                unrecoverable.push(UnrecoverableBinary {
                    path: path.to_string(),
                    hash,
                    current_kept: true,
                });
            } else if *cur_hash != hash || blob_bytes.is_some() {
                let action = if blob_bytes.is_some() {
                    "restoreBlob"
                } else {
                    "modify"
                };
                changes.push(PlannedChange {
                    path: path.to_string(),
                    kind: "binary".into(),
                    action: action.into(),
                });
                ops.push(PlannedOp::SetBinary {
                    path: path.to_string(),
                    hash,
                    size,
                    blob_bytes,
                });
            }
        } else {
            // Current path is absent: classify by target_path's extension.
            let target_kind = history::path_kind(target_path);
            match target_kind {
                "markdown" => {
                    let content = String::from_utf8_lossy(&bytes).to_string();
                    changes.push(PlannedChange {
                        path: path.to_string(),
                        kind: "markdown".into(),
                        action: "create".into(),
                    });
                    ops.push(PlannedOp::SetText {
                        path: path.to_string(),
                        guid: None,
                        content,
                    });
                }
                "canvas" | "base" => {
                    let value = if target_kind == "canvas" {
                        let file: JsonValue = serde_json::from_slice(&bytes).map_err(|e| {
                            AppError::Internal(format!("parse canvas {target_path}: {e}"))
                        })?;
                        crate::structured::canvas_file_to_map(file)
                    } else {
                        let yaml: serde_yaml::Value =
                            serde_yaml::from_slice(&bytes).map_err(|e| {
                                AppError::Internal(format!("parse base {target_path}: {e}"))
                            })?;
                        serde_json::to_value(yaml).map_err(|e| AppError::Internal(e.to_string()))?
                    };
                    changes.push(PlannedChange {
                        path: path.to_string(),
                        kind: target_kind.into(),
                        action: "create".into(),
                    });
                    ops.push(PlannedOp::SetStructured {
                        path: path.to_string(),
                        guid: None,
                        kind: target_kind.into(),
                        value,
                    });
                }
                _ => {
                    // Binary create.
                    let (hash, size, blob_bytes, blob_missing) = match parse_attachment_shim(&bytes)
                    {
                        Some(shim) => {
                            let available = blob_exists(state, vault_id, &shim.hash);
                            (shim.hash, shim.size, None, !available)
                        }
                        None => {
                            let hash = sha256_hex(&bytes);
                            let size = bytes.len() as u64;
                            let missing = !blob_exists(state, vault_id, &hash);
                            let blob_bytes = missing.then(|| bytes.clone());
                            (hash, size, blob_bytes, false)
                        }
                    };
                    if blob_missing {
                        unrecoverable.push(UnrecoverableBinary {
                            path: path.to_string(),
                            hash,
                            current_kept: false,
                        });
                    } else {
                        changes.push(PlannedChange {
                            path: path.to_string(),
                            kind: "binary".into(),
                            action: if blob_bytes.is_some() {
                                "restoreBlob"
                            } else {
                                "create"
                            }
                            .into(),
                        });
                        ops.push(PlannedOp::SetBinary {
                            path: path.to_string(),
                            hash,
                            size,
                            blob_bytes,
                        });
                    }
                }
            }
        }
    } else {
        // Target absent: delete `path` if it currently exists.
        if files.contains_key(path) {
            changes.push(PlannedChange {
                path: path.to_string(),
                kind: "markdown".into(),
                action: "delete".into(),
            });
            ops.push(PlannedOp::RemoveFile {
                path: path.to_string(),
            });
        } else if structured.contains_key(path) {
            let kind = structured
                .get(path)
                .map(|(_, k)| k.clone())
                .unwrap_or_default();
            changes.push(PlannedChange {
                path: path.to_string(),
                kind,
                action: "delete".into(),
            });
            ops.push(PlannedOp::RemoveStructured {
                path: path.to_string(),
            });
        } else if binaries.contains_key(path) {
            changes.push(PlannedChange {
                path: path.to_string(),
                kind: "binary".into(),
                action: "delete".into(),
            });
            ops.push(PlannedOp::RemoveBinary {
                path: path.to_string(),
            });
        }
        // If `path` isn't in any current map, there's nothing to delete — no-op.
    }

    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Plan {
        summary: RollbackPlan {
            target_commit: full,
            changes,
            unrecoverable_binaries: unrecoverable,
            plugin_dbs: Vec::new(),
        },
        ops,
        plugin_targets: Vec::new(),
    })
}

// ---------- handlers ----------

/// `POST /api/vaults/{id}/history/commits/{hash}/rollback/preview`
pub async fn rollback_preview(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    AxumPath((vault_id, hash)): AxumPath<(String, String)>,
    Query(q): Query<RollbackQuery>,
) -> AppResult<Json<RollbackPlan>> {
    require_admin(&state, &user.id, &vault_id).await?;
    let path = validate_rollback_query(&q)?;
    let plan = match path {
        Some((path, target_path)) => {
            plan_single_file_rollback(&state, &vault_id, &hash, &path, &target_path).await?
        }
        None => plan_rollback(&state, &vault_id, &hash).await?,
    };
    Ok(Json(plan.summary))
}

/// `POST /api/vaults/{id}/history/commits/{hash}/rollback`
pub async fn rollback(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    AxumPath((vault_id, hash)): AxumPath<(String, String)>,
    Query(q): Query<RollbackQuery>,
    body: Option<Json<RollbackBody>>,
) -> AppResult<Json<RollbackResult>> {
    require_admin(&state, &user.id, &vault_id).await?;
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let path = validate_rollback_query(&q)?;
    // Single-file rollback never touches plugin DBs.
    if path.is_some() && !body.plugin_dbs.is_empty() {
        return Err(AppError::BadRequest(
            "pluginDbs cannot be combined with path".into(),
        ));
    }
    let principal = Principal {
        user_id: user.id.clone(),
        display_name: user.display_name.clone(),
        email: user.email.clone(),
        git_email: user.git_email.clone(),
        actor: PrincipalActor::User,
        expires_at_ms: now_millis() + 24 * 60 * 60 * 1000,
    };
    let result =
        execute_rollback(&state, &principal, &vault_id, &hash, &body.plugin_dbs, path).await?;
    Ok(Json(result))
}
