//! Read-only REST surface over the per-vault git audit log: commit lists,
//! per-commit change lists/trees, and on-demand file/blob content.
//!
//! All parsing uses NUL-separated (`-z`) git output so unicode and
//! whitespace-containing paths survive round trips.

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio_util::io::ReaderStream;

use crate::error::{AppError, AppResult};
use crate::git::{safe_rel_path, sql_dump_parts, ATTACHMENT_SHIM_VERSION};
use crate::routes::require_member;
use crate::session::AuthUser;
use crate::state::AppState;

// ---------- response shapes ----------

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCommit {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub timestamp_ms: i64,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub principal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub principal_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_behalf_of: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollback_of: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitListResponse {
    pub commits: Vec<HistoryCommit>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitChange {
    pub path: String,
    /// `added` | `modified` | `deleted` | `renamed` | `other`.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renamed_to: Option<String>,
    pub kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetailResponse {
    pub commit: HistoryCommit,
    pub changes: Vec<CommitChange>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub path: String,
    pub size: u64,
    pub kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeResponse {
    pub entries: Vec<TreeEntry>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FileAtCommit {
    #[serde(rename_all = "camelCase")]
    Text {
        content: String,
        lang: String,
    },
    #[serde(rename_all = "camelCase")]
    Binary {
        hash: String,
        size: u64,
        /// Bytes were committed verbatim into git (recoverable from history).
        inline: bool,
        blob_available: bool,
    },
    Absent,
}

// ---------- pure parsers ----------

/// A parsed attachment shim (`version …/attachment-shim/v1` header).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShimInfo {
    pub hash: String,
    pub size: u64,
}

/// Parse the git-LFS-style attachment shim written by `git.rs::attachment_shim`.
pub fn parse_attachment_shim(bytes: &[u8]) -> Option<ShimInfo> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.lines();
    let first = lines.next()?;
    if first.strip_prefix("version ")? != ATTACHMENT_SHIM_VERSION {
        return None;
    }
    let mut hash = None;
    let mut size = None;
    for line in lines {
        if let Some(rest) = line.strip_prefix("oid sha256:") {
            hash = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("size ") {
            size = rest.trim().parse::<u64>().ok();
        }
    }
    Some(ShimInfo {
        hash: hash?,
        size: size?,
    })
}

/// Classify a vault path for display: markdown / canvas / base / sql / binary.
pub fn path_kind(path: &str) -> &'static str {
    if sql_dump_parts(path).is_some() {
        return "sql";
    }
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "md" => "markdown",
        "canvas" => "canvas",
        "base" => "base",
        _ => "binary",
    }
}

fn diff_lang(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "md" => "markdown".to_string(),
        "canvas" | "json" => "json".to_string(),
        "base" | "yaml" | "yml" => "yaml".to_string(),
        other => other.to_string(),
    }
}

/// Parse `git log -z --format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B` output.
pub fn parse_log_records(stdout: &[u8]) -> Vec<HistoryCommit> {
    let text = String::from_utf8_lossy(stdout);
    text.split('\0')
        .filter(|rec| !rec.trim().is_empty())
        .filter_map(|rec| {
            let mut fields = rec.splitn(6, '\u{1f}');
            let hash = fields.next()?.trim_start_matches('\n').to_string();
            let parents: Vec<String> = fields
                .next()?
                .split_whitespace()
                .map(|s| s.to_string())
                .collect();
            let author_name = fields.next()?.to_string();
            let author_email = fields.next()?.to_string();
            let timestamp_ms = fields.next()?.parse::<i64>().ok()? * 1000;
            let body = fields.next()?;
            let subject = body.lines().next().unwrap_or("").to_string();
            let trailers = parse_trailers(body);
            Some(HistoryCommit {
                short_hash: hash.chars().take(10).collect(),
                hash,
                parents,
                author_name,
                author_email,
                timestamp_ms,
                subject,
                principal_id: trailers.get("Principal-Id").cloned(),
                principal_type: trailers.get("Principal-Type").cloned(),
                cursor_id: trailers.get("Cursor-Id").cloned(),
                cursor_name: trailers.get("Cursor-Name").cloned(),
                on_behalf_of: trailers.get("On-Behalf-Of").cloned(),
                rollback_of: trailers.get("Rollback-Of").cloned(),
            })
        })
        .collect()
}

/// Collect `Key: value` trailers from a full commit message (first wins).
pub fn parse_trailers(body: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for line in body.lines() {
        if let Some((key, value)) = line.split_once(": ") {
            if key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !key.is_empty() {
                out.entry(key.to_string())
                    .or_insert_with(|| value.to_string());
            }
        }
    }
    out
}

/// Parse `git diff-tree -r -z --root --find-renames --name-status <hash>`.
/// Records are `STATUS\0path\0` (or `R<score>\0old\0new\0`); the leading
/// commit id record (if present) is skipped.
pub fn parse_diff_tree_z(stdout: &[u8]) -> Vec<CommitChange> {
    let text = String::from_utf8_lossy(stdout);
    let mut parts = text.split('\0').peekable();
    let mut out = Vec::new();
    while let Some(part) = parts.next() {
        let part = part.trim_start_matches('\n');
        if part.is_empty() {
            continue;
        }
        // diff-tree echoes the commit hash as its own record.
        if part.len() == 40 && part.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let status_char = part.chars().next().unwrap_or('?');
        let (status, path, renamed_to) = match status_char {
            'R' | 'C' => {
                let old = parts.next().unwrap_or("").to_string();
                let new = parts.next().unwrap_or("").to_string();
                ("renamed", old, Some(new))
            }
            'A' => ("added", parts.next().unwrap_or("").to_string(), None),
            'D' => ("deleted", parts.next().unwrap_or("").to_string(), None),
            'M' => ("modified", parts.next().unwrap_or("").to_string(), None),
            _ => ("other", parts.next().unwrap_or("").to_string(), None),
        };
        if path.is_empty() {
            continue;
        }
        // For renames, kind describes the destination file.
        let kind = path_kind(renamed_to.as_deref().unwrap_or(&path)).to_string();
        out.push(CommitChange {
            kind,
            path,
            status: status.to_string(),
            renamed_to,
        });
    }
    out
}

/// Parse `git ls-tree -r -l -z <hash>`: `<mode> <type> <obj> <size>\t<path>\0`.
pub fn parse_ls_tree_z(stdout: &[u8]) -> Vec<TreeEntry> {
    let text = String::from_utf8_lossy(stdout);
    text.split('\0')
        .filter(|rec| !rec.is_empty())
        .filter_map(|rec| {
            let (meta, path) = rec.split_once('\t')?;
            let mut fields = meta.split_whitespace();
            let _mode = fields.next()?;
            let typ = fields.next()?;
            let _obj = fields.next()?;
            let size = fields.next()?.parse::<u64>().unwrap_or(0);
            if typ != "blob" {
                return None;
            }
            Some(TreeEntry {
                path: path.to_string(),
                size,
                kind: path_kind(path).to_string(),
            })
        })
        .collect()
}

// ---------- helpers ----------

fn validate_hash(hash: &str) -> AppResult<()> {
    let ok = (4..=40).contains(&hash.len())
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if ok {
        Ok(())
    } else {
        Err(AppError::BadRequest("invalid commit hash".into()))
    }
}

/// Resolve `hash` to a full commit id in this vault's repo, or 404.
pub(crate) async fn resolve_commit(
    state: &AppState,
    vault_id: &str,
    hash: &str,
) -> AppResult<String> {
    validate_hash(hash)?;
    if state
        .git
        .repo_dir(vault_id)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .is_none()
    {
        return Err(AppError::NotFound);
    }
    let spec = format!("{hash}^{{commit}}");
    let out = state
        .git
        .git_output(vault_id, &["rev-parse", "--verify", "--quiet", &spec])
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if !out.status.success() {
        return Err(AppError::NotFound);
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn validated_rel_path(path: &str) -> AppResult<String> {
    safe_rel_path(path).map_err(|e| AppError::BadRequest(e.to_string()))?;
    Ok(path.to_string())
}

/// `git show {hash}:{path}` → Some(bytes) or None when absent at that commit.
pub(crate) async fn file_bytes_at(
    state: &AppState,
    vault_id: &str,
    full_hash: &str,
    path: &str,
) -> AppResult<Option<Vec<u8>>> {
    let spec = format!("{full_hash}:{path}");
    let out = state
        .git
        .git_output(vault_id, &["show", &spec])
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if !out.status.success() {
        return Ok(None);
    }
    Ok(Some(out.stdout))
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn blob_exists(state: &AppState, vault_id: &str, hash: &str) -> bool {
    crate::blobs::blob_fs_path(&state.config.blob_dir, vault_id, hash)
        .map(|p| p.exists())
        .unwrap_or(false)
}

pub(crate) fn classify_file_bytes(
    state: &AppState,
    vault_id: &str,
    path: &str,
    bytes: Vec<u8>,
) -> FileAtCommit {
    if let Some(shim) = parse_attachment_shim(&bytes) {
        let blob_available = blob_exists(state, vault_id, &shim.hash);
        return FileAtCommit::Binary {
            hash: shim.hash,
            size: shim.size,
            inline: false,
            blob_available,
        };
    }
    match String::from_utf8(bytes) {
        Ok(content) if !content.contains('\0') => FileAtCommit::Text {
            lang: diff_lang(path),
            content,
        },
        Ok(content) => {
            let bytes = content.into_bytes();
            FileAtCommit::Binary {
                hash: sha256_hex(&bytes),
                size: bytes.len() as u64,
                inline: true,
                blob_available: true,
            }
        }
        Err(e) => {
            let bytes = e.into_bytes();
            FileAtCommit::Binary {
                hash: sha256_hex(&bytes),
                size: bytes.len() as u64,
                inline: true,
                blob_available: true,
            }
        }
    }
}

// ---------- handlers ----------

#[derive(Deserialize)]
pub struct CommitListQuery {
    pub limit: Option<u64>,
    /// Keyset cursor: list commits strictly before this commit hash.
    pub before: Option<String>,
    /// Restrict to one file's history (`git log --follow`).
    pub path: Option<String>,
}

/// `GET /api/vaults/{id}/history/commits`
pub async fn list_commits(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(vault_id): Path<String>,
    Query(q): Query<CommitListQuery>,
) -> AppResult<Json<CommitListResponse>> {
    require_member(&state, &user.id, &vault_id).await?;
    let empty = CommitListResponse {
        commits: Vec::new(),
        has_more: false,
    };
    if state
        .git
        .repo_dir(&vault_id)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .is_none()
    {
        return Ok(Json(empty));
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 200);

    let start = match &q.before {
        Some(before) => {
            let full = resolve_commit(&state, &vault_id, before).await?;
            format!("{full}^")
        }
        None => "HEAD".to_string(),
    };
    let count = format!("-n{}", limit + 1);
    let mut args: Vec<&str> = vec![
        "log",
        "-z",
        "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B",
        &count,
        &start,
    ];
    let rel;
    if let Some(path) = &q.path {
        rel = validated_rel_path(path)?;
        args.push("--follow");
        args.push("--");
        args.push(&rel);
    }
    let out = state
        .git
        .git_output(&vault_id, &args)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if !out.status.success() {
        // No commits yet (empty repo) or `before` was the root commit.
        return Ok(Json(empty));
    }
    let mut commits = parse_log_records(&out.stdout);
    let has_more = commits.len() as u64 > limit;
    commits.truncate(limit as usize);
    Ok(Json(CommitListResponse { commits, has_more }))
}

/// `GET /api/vaults/{id}/history/commits/{hash}`
pub async fn get_commit(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((vault_id, hash)): Path<(String, String)>,
) -> AppResult<Json<CommitDetailResponse>> {
    require_member(&state, &user.id, &vault_id).await?;
    let full = resolve_commit(&state, &vault_id, &hash).await?;

    let log = state
        .git
        .git_output(
            &vault_id,
            &[
                "log",
                "-z",
                "-n1",
                "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B",
                &full,
            ],
        )
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let commit = parse_log_records(&log.stdout)
        .into_iter()
        .next()
        .ok_or(AppError::NotFound)?;

    let diff = state
        .git
        .git_output(
            &vault_id,
            &[
                "diff-tree",
                "-r",
                "-z",
                "--root",
                "--find-renames",
                "--name-status",
                &full,
            ],
        )
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if !diff.status.success() {
        return Err(AppError::Internal("diff-tree failed".into()));
    }
    Ok(Json(CommitDetailResponse {
        commit,
        changes: parse_diff_tree_z(&diff.stdout),
    }))
}

/// `GET /api/vaults/{id}/history/commits/{hash}/tree`
pub async fn get_tree(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((vault_id, hash)): Path<(String, String)>,
) -> AppResult<Json<TreeResponse>> {
    require_member(&state, &user.id, &vault_id).await?;
    let full = resolve_commit(&state, &vault_id, &hash).await?;
    let out = state
        .git
        .git_output(&vault_id, &["ls-tree", "-r", "-l", "-z", &full])
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if !out.status.success() {
        return Err(AppError::Internal("ls-tree failed".into()));
    }
    Ok(Json(TreeResponse {
        entries: parse_ls_tree_z(&out.stdout),
    }))
}

#[derive(Deserialize)]
pub struct FileQuery {
    pub path: String,
}

/// `GET /api/vaults/{id}/history/commits/{hash}/file?path=…`
pub async fn get_file(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((vault_id, hash)): Path<(String, String)>,
    Query(q): Query<FileQuery>,
) -> AppResult<Json<FileAtCommit>> {
    require_member(&state, &user.id, &vault_id).await?;
    let full = resolve_commit(&state, &vault_id, &hash).await?;
    let path = validated_rel_path(&q.path)?;
    let Some(bytes) = file_bytes_at(&state, &vault_id, &full, &path).await? else {
        return Ok(Json(FileAtCommit::Absent));
    };
    Ok(Json(classify_file_bytes(&state, &vault_id, &path, bytes)))
}

/// `GET /api/vaults/{id}/history/commits/{hash}/blob?path=…` — raw bytes for
/// previews. Shims are resolved through the blob store; a GC'd blob is 410.
pub async fn get_blob(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((vault_id, hash)): Path<(String, String)>,
    Query(q): Query<FileQuery>,
) -> AppResult<Response> {
    require_member(&state, &user.id, &vault_id).await?;
    let full = resolve_commit(&state, &vault_id, &hash).await?;
    let path = validated_rel_path(&q.path)?;
    let bytes = file_bytes_at(&state, &vault_id, &full, &path)
        .await?
        .ok_or(AppError::NotFound)?;

    if let Some(shim) = parse_attachment_shim(&bytes) {
        let fs_path = crate::blobs::blob_fs_path(&state.config.blob_dir, &vault_id, &shim.hash)
            .map_err(AppError::BadRequest)?;
        return match tokio::fs::File::open(&fs_path).await {
            Ok(file) => Ok(Response::builder()
                .header(axum::http::header::CONTENT_TYPE, "application/octet-stream")
                .body(Body::from_stream(ReaderStream::new(file)))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())),
            Err(_) => Ok((
                StatusCode::GONE,
                Json(serde_json::json!({ "error": "blob no longer available" })),
            )
                .into_response()),
        };
    }

    Ok(Response::builder()
        .header(axum::http::header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_trailers() {
        let body = "Update a.md\n\nVault-Id: v1\nPrincipal-Id: u1\nPrincipal-Type: user\nRollback-Of: abc123\n";
        let t = parse_trailers(body);
        assert_eq!(t.get("Principal-Id").unwrap(), "u1");
        assert_eq!(t.get("Rollback-Of").unwrap(), "abc123");
        assert!(t.get("Missing").is_none());
    }

    #[test]
    fn parses_shim() {
        let shim = format!(
            "version {ATTACHMENT_SHIM_VERSION}\noid sha256:{}\nsize 42\nvault v1\n",
            "ab".repeat(32)
        );
        assert_eq!(
            parse_attachment_shim(shim.as_bytes()),
            Some(ShimInfo {
                hash: "ab".repeat(32),
                size: 42
            })
        );
        assert_eq!(parse_attachment_shim(b"not a shim"), None);
        assert_eq!(parse_attachment_shim(&[0xff, 0xfe]), None);
    }

    #[test]
    fn classifies_paths() {
        assert_eq!(path_kind("a.md"), "markdown");
        assert_eq!(path_kind("b.canvas"), "canvas");
        assert_eq!(path_kind("c.base"), "base");
        assert_eq!(path_kind("img/x.png"), "binary");
        assert_eq!(path_kind(".sql/p/n.sql"), "sql");
    }

    #[test]
    fn parses_diff_tree_z() {
        let out = b"abcdefabcdefabcdefabcdefabcdefabcdefabcd\0M\0note.md\0A\0dir/n\xc3\xb6te.md\0R100\0old.md\0new name.md\0D\0img/a.png\0";
        let changes = parse_diff_tree_z(out);
        assert_eq!(changes.len(), 4);
        assert_eq!(changes[0].path, "note.md");
        assert_eq!(changes[0].status, "modified");
        assert_eq!(changes[1].path, "dir/nöte.md");
        assert_eq!(changes[2].status, "renamed");
        assert_eq!(changes[2].renamed_to.as_deref(), Some("new name.md"));
        assert_eq!(changes[3].status, "deleted");
        assert_eq!(changes[3].kind, "binary");
    }

    #[test]
    fn parses_ls_tree_z() {
        let out = b"100644 blob 1111111111111111111111111111111111111111      12\ta.md\0100644 blob 2222222222222222222222222222222222222222    3456\timg/sp ace.png\0";
        let entries = parse_ls_tree_z(out);
        assert_eq!(
            entries,
            vec![
                TreeEntry {
                    path: "a.md".into(),
                    size: 12,
                    kind: "markdown".into()
                },
                TreeEntry {
                    path: "img/sp ace.png".into(),
                    size: 3456,
                    kind: "binary".into()
                },
            ]
        );
    }

    /// End-to-end against a real temp repo: unicode and space-containing
    /// paths must survive `-z` parsing of log, diff-tree, and ls-tree.
    #[test]
    fn z_parsers_against_real_repo() {
        let dir = std::env::temp_dir().join(format!("realtime-hist-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {:?}", out);
            out.stdout
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "Tester"]);
        git(&["config", "user.email", "t@x"]);
        git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("nöte one.md"), "hello").unwrap();
        git(&["add", "-A"]);
        git(&[
            "commit",
            "-q",
            "-m",
            "Add nöte one.md\n\nVault-Id: v1\nPrincipal-Id: u1",
        ]);
        std::fs::rename(dir.join("nöte one.md"), dir.join("nöte two.md")).unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "Rename"]);

        let log = git(&["log", "-z", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B"]);
        let commits = parse_log_records(&log);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[1].subject, "Add nöte one.md");
        assert_eq!(commits[1].principal_id.as_deref(), Some("u1"));
        assert_eq!(commits[0].parents, vec![commits[1].hash.clone()]);

        let diff = git(&[
            "diff-tree",
            "-r",
            "-z",
            "--root",
            "--find-renames",
            "--name-status",
            &commits[0].hash,
        ]);
        let changes = parse_diff_tree_z(&diff);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].status, "renamed");
        assert_eq!(changes[0].path, "nöte one.md");
        assert_eq!(changes[0].renamed_to.as_deref(), Some("nöte two.md"));

        let tree = git(&["ls-tree", "-r", "-l", "-z", &commits[0].hash]);
        let entries = parse_ls_tree_z(&tree);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "nöte two.md");
        assert_eq!(entries[0].size, 5);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_log_records() {
        let rec = format!(
            "{h}\u{1f}{p}\u{1f}Alice\u{1f}a@x\u{1f}1700000000\u{1f}Update a.md\n\nVault-Id: v1\nPrincipal-Id: u1\n\0",
            h = "a".repeat(40),
            p = "b".repeat(40),
        );
        let commits = parse_log_records(rec.as_bytes());
        assert_eq!(commits.len(), 1);
        let c = &commits[0];
        assert_eq!(c.hash, "a".repeat(40));
        assert_eq!(c.short_hash, "a".repeat(10));
        assert_eq!(c.parents, vec!["b".repeat(40)]);
        assert_eq!(c.author_name, "Alice");
        assert_eq!(c.timestamp_ms, 1_700_000_000_000);
        assert_eq!(c.subject, "Update a.md");
        assert_eq!(c.principal_id.as_deref(), Some("u1"));
        assert!(c.rollback_of.is_none());
    }
}
