//! Content-addressed binary blob store.
//!
//! Markdown files sync through y-sweet, but binary attachments (images, PDFs, …)
//! would bloat the text CRDT. Instead the plugin syncs only a `path -> sha256`
//! mapping through the index doc and stores the bytes here, keyed by their hash.
//!
//! Blobs live on the filesystem under `{blob_dir}/{vault_id}/{hash}`, alongside
//! the y-sweet data. Access is vault-scoped: any member of the vault may read or
//! write any blob in it (matching the current allow-all-within-vault ACL posture).
//! Uploads are content-verified — the streamed bytes must hash to the claimed
//! `hash` — so a member cannot poison a hash with mismatched content.

use std::path::{Path as FsPath, PathBuf};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use crate::error::{AppError, AppResult};
use crate::routes::require_member;
use crate::session::AuthUser;
use crate::state::AppState;

/// A sha256 hex digest is exactly 64 lowercase hex characters. Validating this
/// before building any path is what keeps `hash` from escaping the blob dir.
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Resolve the on-disk path for a blob, after validating both segments.
fn blob_path(state: &AppState, vault_id: &str, hash: &str) -> AppResult<PathBuf> {
    if !valid_hash(hash) {
        return Err(AppError::BadRequest("invalid blob hash".into()));
    }
    // vault_id is a server-issued UUID, but guard against separators regardless.
    if vault_id.is_empty() || vault_id.contains('/') || vault_id.contains('\\') || vault_id.contains("..") {
        return Err(AppError::BadRequest("invalid vault id".into()));
    }
    let mut p = PathBuf::from(&state.config.blob_dir);
    p.push(vault_id);
    p.push(hash);
    Ok(p)
}

/// `HEAD /api/vaults/{id}/blobs/{hash}` — 200 if present, 404 otherwise. Lets the
/// client skip an upload when the server already has the content (dedup).
pub async fn head_blob(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((vault_id, hash)): Path<(String, String)>,
) -> AppResult<StatusCode> {
    require_member(&state, &user.id, &vault_id).await?;
    let path = blob_path(&state, &vault_id, &hash)?;
    match tokio::fs::metadata(&path).await {
        Ok(_) => Ok(StatusCode::OK),
        Err(_) => Err(AppError::NotFound),
    }
}

/// `GET /api/vaults/{id}/blobs/{hash}` — stream the blob bytes back.
pub async fn get_blob(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((vault_id, hash)): Path<(String, String)>,
) -> AppResult<Response> {
    require_member(&state, &user.id, &vault_id).await?;
    let path = blob_path(&state, &vault_id, &hash)?;

    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| AppError::NotFound)?;
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    Ok(Response::builder()
        .header(axum::http::header::CONTENT_TYPE, "application/octet-stream")
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()))
}

/// `PUT /api/vaults/{id}/blobs/{hash}` — stream the request body to disk, verify
/// it hashes to `hash`, then atomically publish it. Idempotent: an already-present
/// blob is accepted without rewriting (the body is still drained).
pub async fn put_blob(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((vault_id, hash)): Path<(String, String)>,
    body: Body,
) -> AppResult<StatusCode> {
    require_member(&state, &user.id, &vault_id).await?;
    let path = blob_path(&state, &vault_id, &hash)?;

    // Already stored: short-circuit. Content addressing makes this safe.
    if tokio::fs::metadata(&path).await.is_ok() {
        return Ok(StatusCode::OK);
    }

    let dir = path
        .parent()
        .ok_or_else(|| AppError::Internal("blob path has no parent".into()))?;
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| AppError::Internal(format!("blob mkdir: {e}")))?;

    // Stream to a unique temp file in the same dir (so the rename is atomic),
    // hashing as we go.
    let tmp = dir.join(format!(".tmp-{}", uuid::Uuid::new_v4()));
    let actual = match stream_to_file(body, &tmp).await {
        Ok(h) => h,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e);
        }
    };

    if actual != hash {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(AppError::Conflict(format!(
            "content hash {actual} does not match {hash}"
        )));
    }

    // Atomic publish. A concurrent uploader of the same content is harmless: the
    // rename just replaces an identical file.
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| AppError::Internal(format!("blob publish: {e}")))?;

    Ok(StatusCode::OK)
}

/// Stream `body` into `tmp`, returning the lowercase hex sha256 of the bytes.
async fn stream_to_file(body: Body, tmp: &FsPath) -> AppResult<String> {
    let mut file = tokio::fs::File::create(tmp)
        .await
        .map_err(|e| AppError::Internal(format!("blob create: {e}")))?;
    let mut hasher = Sha256::new();
    let mut stream = body.into_data_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::BadRequest(format!("upload stream: {e}")))?;
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| AppError::Internal(format!("blob write: {e}")))?;
    }
    file.flush()
        .await
        .map_err(|e| AppError::Internal(format!("blob flush: {e}")))?;

    Ok(hex_lower(&hasher.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_hash_accepts_64_hex() {
        assert!(valid_hash(&"a".repeat(64)));
        assert!(valid_hash(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        ));
    }

    #[test]
    fn valid_hash_rejects_bad_input() {
        assert!(!valid_hash(""));
        assert!(!valid_hash(&"a".repeat(63)));
        assert!(!valid_hash(&"a".repeat(65)));
        assert!(!valid_hash(&"A".repeat(64))); // uppercase
        assert!(!valid_hash("../../etc/passwd"));
        assert!(!valid_hash(&"g".repeat(64))); // non-hex
    }
}
