//! Per-vault storage accounting + orphaned-blob cleanup.
//!
//! Surfaces the storage a vault occupies on the server, split into three
//! buckets for the plugin's "Storage Management" panel:
//!  - **current** binary attachments — blobs referenced by the live `binaries`
//!    or `configFiles` index maps;
//!  - **previous** binary attachments — orphaned blobs no longer referenced by
//!    the live map (older versions and the content behind trashed/deleted files);
//!  - **plain vault** — the internal y-sweet document store for this vault
//!    (only when `YSWEET_STORE` is configured and readable).
//!
//! The cleanup endpoint deletes orphaned ("previous") blobs. It deliberately
//! never touches blobs referenced by the live map, but removing previous
//! versions does forfeit the ability to restore those older/deleted versions —
//! the plugin warns the user before calling it.

use std::collections::HashSet;
use std::path::PathBuf;

use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::routes::{require_admin, require_member};
use crate::session::AuthUser;
use crate::state::AppState;
use crate::ydoc;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub blobs_current_bytes: u64,
    pub blobs_previous_bytes: u64,
    pub current_blob_count: u64,
    pub previous_blob_count: u64,
    /// `None` when the y-sweet store path is not configured / not readable.
    pub plain_vault_bytes: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcBlobsBody {
    /// Only delete orphaned blobs at least this large (bytes). Defaults to 0.
    pub min_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcBlobsResult {
    pub removed: u64,
    pub freed_bytes: u64,
}

/// A sha256 hex digest is exactly 64 lowercase hex characters. Filters out
/// in-flight `.tmp-*` files and anything that isn't a content blob.
fn is_blob_name(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn vault_blob_dir(state: &AppState, vault_id: &str) -> PathBuf {
    let mut p = PathBuf::from(&state.config.blob_dir);
    p.push(vault_id);
    p
}

/// Hashes referenced by the live `binaries` and `configFiles` index maps (the
/// "current" set). Config-folder files share the attachment blob store, so
/// they must count as live or GC would delete them out from under peers.
async fn live_blob_hashes(state: &AppState, vault_id: &str) -> AppResult<HashSet<String>> {
    let current = ydoc::read_update(state, vault_id).await?;
    let mut hashes = HashSet::new();
    let entries = ydoc::decode_binaries_map(&current)
        .map_err(|e| crate::error::AppError::Internal(e.to_string()))?;
    for (_path, value) in entries {
        if let yrs::Any::Map(meta) = value {
            if let Some(yrs::Any::String(hash)) = meta.get("hash") {
                hashes.insert(hash.to_string());
            }
        }
    }
    let config_entries = ydoc::decode_config_entries(&current)
        .map_err(|e| crate::error::AppError::Internal(e.to_string()))?;
    for entry in config_entries {
        hashes.insert(entry.hash);
    }
    Ok(hashes)
}

/// `GET /api/vaults/{id}/storage` — admin-only storage breakdown for the vault.
pub async fn get_storage(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(vault_id): Path<String>,
) -> AppResult<Json<StorageUsage>> {
    require_admin(&state, &user.id, &vault_id).await?;

    let live = live_blob_hashes(&state, &vault_id).await?;

    let mut current_bytes = 0u64;
    let mut previous_bytes = 0u64;
    let mut current_count = 0u64;
    let mut previous_count = 0u64;

    let dir = vault_blob_dir(&state, &vault_id);
    if let Ok(mut rd) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !is_blob_name(name) {
                continue;
            }
            let Ok(meta) = entry.metadata().await else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let len = meta.len();
            if live.contains(name) {
                current_bytes += len;
                current_count += 1;
            } else {
                previous_bytes += len;
                previous_count += 1;
            }
        }
    }

    let plain_vault_bytes = plain_vault_bytes(&state, &vault_id).await;

    Ok(Json(StorageUsage {
        blobs_current_bytes: current_bytes,
        blobs_previous_bytes: previous_bytes,
        current_blob_count: current_count,
        previous_blob_count: previous_count,
        plain_vault_bytes,
    }))
}

/// `POST /api/vaults/{id}/storage/gc-blobs` — delete orphaned ("previous") blobs.
pub async fn gc_blobs(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(vault_id): Path<String>,
    Json(body): Json<GcBlobsBody>,
) -> AppResult<Json<GcBlobsResult>> {
    require_admin(&state, &user.id, &vault_id).await?;

    let live = live_blob_hashes(&state, &vault_id).await?;
    let min_bytes = body.min_bytes.unwrap_or(0);

    let mut removed = 0u64;
    let mut freed_bytes = 0u64;

    let dir = vault_blob_dir(&state, &vault_id);
    if let Ok(mut rd) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !is_blob_name(name) || live.contains(name) {
                continue;
            }
            let Ok(meta) = entry.metadata().await else {
                continue;
            };
            if !meta.is_file() || meta.len() < min_bytes {
                continue;
            }
            let len = meta.len();
            if tokio::fs::remove_file(entry.path()).await.is_ok() {
                removed += 1;
                freed_bytes += len;
            }
        }
    }

    Ok(Json(GcBlobsResult {
        removed,
        freed_bytes,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBlobResult {
    pub deleted: bool,
}

/// `DELETE /api/vaults/{id}/blobs/{hash}` — reclaim a single orphaned blob (used
/// when permanently deleting a trashed attachment). Refuses to delete a blob that
/// is still referenced by the live `binaries` map, so a shared/in-use blob is
/// never removed. Idempotent: a missing blob reports `deleted: true`.
pub async fn delete_blob(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((vault_id, hash)): Path<(String, String)>,
) -> AppResult<Json<DeleteBlobResult>> {
    require_member(&state, &user.id, &vault_id).await?;
    if !is_blob_name(&hash) {
        return Err(AppError::BadRequest("invalid blob hash".into()));
    }
    let live = live_blob_hashes(&state, &vault_id).await?;
    if live.contains(&hash) {
        return Ok(Json(DeleteBlobResult { deleted: false }));
    }
    let mut path = vault_blob_dir(&state, &vault_id);
    path.push(&hash);
    match tokio::fs::remove_file(&path).await {
        Ok(_) => Ok(Json(DeleteBlobResult { deleted: true })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(Json(DeleteBlobResult { deleted: true }))
        }
        Err(e) => Err(AppError::Internal(format!("blob delete: {e}"))),
    }
}

/// Sum the on-disk size of this vault's y-sweet docs, identified by store entries
/// named `{vault_id}` (the index doc) or `{vault_id}__*` (per-file docs). Returns
/// `None` if `YSWEET_STORE` is unset or the directory can't be read.
async fn plain_vault_bytes(state: &AppState, vault_id: &str) -> Option<u64> {
    let store = state.config.ysweet_store_dir.as_ref()?;
    let mut total = 0u64;

    let mut rd = tokio::fs::read_dir(store).await.ok()?;
    let prefix = format!("{vault_id}__");
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name != vault_id && !name.starts_with(&prefix) {
            continue;
        }
        total += dir_or_file_size(entry.path()).await;
    }

    Some(total)
}

/// Total size of a path: the file's length, or the recursive sum of a directory.
async fn dir_or_file_size(path: PathBuf) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path];
    while let Some(p) = stack.pop() {
        let Ok(meta) = tokio::fs::metadata(&p).await else {
            continue;
        };
        if meta.is_file() {
            total += meta.len();
        } else if meta.is_dir() {
            if let Ok(mut rd) = tokio::fs::read_dir(&p).await {
                while let Ok(Some(entry)) = rd.next_entry().await {
                    stack.push(entry.path());
                }
            }
        }
    }
    total
}
