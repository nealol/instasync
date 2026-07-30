use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::Json;
use regex::Regex;
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Statement, Value};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::config::Config;
use crate::entities::{memberships, note_search, vaults};
use crate::error::{AppError, AppResult};
use crate::routes::require_member;
use crate::session::{now_millis, ApiPrincipal};
use crate::state::AppState;
use crate::ydoc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedNote {
    pub title: String,
    pub tags: Vec<String>,
    pub links: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub guid: String,
    pub title: String,
    pub permalink: String,
    pub snippet: String,
}

#[derive(Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReindexResponse {
    pub count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearFtsAndReindexResponse {
    pub vaults: usize,
    pub count: usize,
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
    pub limit: Option<u32>,
}

pub fn parse_note(content: &str, path: &str) -> ParsedNote {
    let frontmatter = frontmatter_value(content);
    let title = frontmatter
        .as_ref()
        .and_then(|v| v.get("title"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| stem(path).to_string());

    let mut tags = Vec::new();
    if let Some(v) = frontmatter.as_ref().and_then(|v| v.get("tags")) {
        collect_yaml_tags(v, &mut tags);
    }
    let inline = Regex::new(r"(^|\s)#([A-Za-z0-9_/-]+)").unwrap();
    for cap in inline.captures_iter(content) {
        tags.push(cap[2].to_ascii_lowercase());
    }
    tags.sort();
    tags.dedup();

    let mut links = Vec::new();
    let wiki = Regex::new(r"!?\[\[([^\]|#]+)(#[^\]|]+)?(?:\|[^\]]*)?\]\]").unwrap();
    for cap in wiki.captures_iter(content) {
        push_link_keys(&mut links, cap[1].trim());
    }
    let md = Regex::new(r"\[[^\]]+\]\(([^)]+\.md)(?:#[^)]+)?\)").unwrap();
    for cap in md.captures_iter(content) {
        push_link_keys(&mut links, cap[1].trim());
    }
    links.sort();
    links.dedup();

    ParsedNote { title, tags, links }
}

pub fn rewrite_links(content: &str, old_path: &str, new_path: &str) -> (String, bool) {
    let wiki = Regex::new(r"(!?\[\[)([^\]|#]+)(#[^\]|]+)?(\|[^\]]*)?(\]\])").unwrap();
    let mut changed = false;
    let out = wiki
        .replace_all(content, |cap: &regex::Captures| {
            if let Some(target) = rewrite_target(&cap[2], old_path, new_path) {
                changed = true;
                format!(
                    "{}{}{}{}{}",
                    &cap[1],
                    target,
                    cap.get(3).map_or("", |m| m.as_str()),
                    cap.get(4).map_or("", |m| m.as_str()),
                    &cap[5]
                )
            } else {
                cap[0].to_string()
            }
        })
        .to_string();

    let md = Regex::new(r"(!?\[[^\]]*\]\()([^)#]+)(#[^)]+)?(\))").unwrap();
    let out = md
        .replace_all(&out, |cap: &regex::Captures| {
            if let Some(target) = rewrite_target(&cap[2], old_path, new_path) {
                changed = true;
                format!(
                    "{}{}{}{}",
                    &cap[1],
                    target,
                    cap.get(3).map_or("", |m| m.as_str()),
                    &cap[4]
                )
            } else {
                cap[0].to_string()
            }
        })
        .to_string();
    (out, changed)
}

pub fn rewrite_target(target: &str, old_path: &str, new_path: &str) -> Option<String> {
    let target = target.trim();
    if is_url_like(target) || target.starts_with('#') || target.trim().is_empty() {
        return None;
    }

    let is_note = old_path.ends_with(".md");
    let target_has_md = target.ends_with(".md");
    let target_has_slash = target.contains('/') || target.contains('\\');
    let normalized_target = normalize_path_for_rewrite(target);
    let normalized_old = normalize_path_for_rewrite(old_path);

    let replacement = if is_note {
        if normalized_target.trim_end_matches(".md") == normalized_old.trim_end_matches(".md") {
            if target_has_md {
                new_path.to_string()
            } else {
                new_path.trim_end_matches(".md").to_string()
            }
        } else if !target_has_slash && eq_basename(target, old_path, true) {
            let new_stem = stem(new_path);
            if target_has_md {
                format!("{new_stem}.md")
            } else {
                new_stem.to_string()
            }
        } else {
            return None;
        }
    } else if normalized_target == normalized_old {
        new_path.to_string()
    } else if !target_has_slash && eq_basename(target, old_path, false) {
        new_path.rsplit('/').next().unwrap_or(new_path).to_string()
    } else {
        return None;
    };

    if replacement == target {
        None
    } else {
        Some(replacement)
    }
}

pub async fn index_note(
    state: &AppState,
    vault_id: &str,
    guid: &str,
    path: &str,
    content: &str,
) -> AppResult<()> {
    let parsed = parse_note(content, path);
    let tags =
        serde_json::to_string(&parsed.tags).map_err(|e| AppError::Internal(e.to_string()))?;
    let links =
        serde_json::to_string(&parsed.links).map_err(|e| AppError::Internal(e.to_string()))?;
    let now = now_millis();
    let tag_text = parsed.tags.join(" ");
    let backend = state.db.get_database_backend();
    state
        .db
        .execute(Statement::from_sql_and_values(
            backend,
            "INSERT INTO note_search(id,vault_id,guid,path,title,tags,links,updated_at) \
             VALUES (?,?,?,?,?,?,?,?) \
             ON CONFLICT(vault_id,guid) DO UPDATE SET \
             path = excluded.path, title = excluded.title, tags = excluded.tags, \
             links = excluded.links, updated_at = excluded.updated_at",
            [
                Value::from(uuid::Uuid::new_v4().to_string()),
                Value::from(vault_id),
                Value::from(guid),
                Value::from(path),
                Value::from(parsed.title.as_str()),
                Value::from(tags.as_str()),
                Value::from(links.as_str()),
                Value::from(now),
            ],
        ))
        .await?;
    let fts_rowid = note_fts_rowid(vault_id, guid);
    state
        .db
        .execute(Statement::from_sql_and_values(
            backend,
            "DELETE FROM note_fts WHERE rowid = ?",
            [Value::from(fts_rowid)],
        ))
        .await?;
    state
        .db
        .execute(Statement::from_sql_and_values(
            backend,
            "INSERT INTO note_fts(rowid,vault_id,guid,path,title,tags,body) VALUES (?,?,?,?,?,?,?)",
            [
                Value::from(fts_rowid),
                Value::from(vault_id),
                Value::from(guid),
                Value::from(path),
                Value::from(parsed.title.as_str()),
                Value::from(tag_text.as_str()),
                Value::from(content),
            ],
        ))
        .await?;
    Ok(())
}

pub async fn remove_note(state: &AppState, vault_id: &str, guid: &str) -> AppResult<()> {
    note_search::Entity::delete_many()
        .filter(note_search::Column::VaultId.eq(vault_id))
        .filter(note_search::Column::Guid.eq(guid))
        .exec(&state.db)
        .await?;
    state
        .db
        .execute(Statement::from_sql_and_values(
            state.db.get_database_backend(),
            "DELETE FROM note_fts WHERE rowid = ?",
            [Value::from(note_fts_rowid(vault_id, guid))],
        ))
        .await?;
    Ok(())
}

fn note_fts_rowid(vault_id: &str, guid: &str) -> i64 {
    let mut hasher = Sha256::new();
    hasher.update(vault_id.as_bytes());
    hasher.update([0]);
    hasher.update(guid.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    (i64::from_be_bytes(bytes) & i64::MAX).max(1)
}

pub async fn reindex_vault(state: &AppState, vault_id: &str) -> AppResult<usize> {
    let update = ydoc::read_update(state, vault_id).await?;
    let files = ydoc::decode_files_map(&update).map_err(|e| AppError::Internal(e.to_string()))?;
    let live: HashSet<String> = files.iter().map(|(_, guid)| guid.clone()).collect();
    let mut count = 0;
    for (path, guid) in files {
        let doc_id = format!("{vault_id}__{guid}");
        let update = match ydoc::read_update(state, &doc_id).await {
            Ok(update) => update,
            Err(e) => {
                tracing::warn!("search reindex: read {doc_id} failed: {e}");
                continue;
            }
        };
        let content = match ydoc::decode_text(&update, "contents") {
            Ok(content) => content,
            Err(e) => {
                tracing::warn!("search reindex: decode {path} failed: {e}");
                continue;
            }
        };
        index_note(state, vault_id, &guid, &path, &content).await?;
        count += 1;
    }
    let rows = note_search::Entity::find()
        .filter(note_search::Column::VaultId.eq(vault_id))
        .all(&state.db)
        .await?;
    for row in rows {
        if !live.contains(&row.guid) {
            remove_note(state, vault_id, &row.guid).await?;
        }
    }
    Ok(count)
}

async fn clear_note_fts(state: &AppState) -> AppResult<()> {
    state.db.execute_unprepared("DELETE FROM note_fts").await?;
    Ok(())
}

pub async fn search_notes_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    query: &str,
    limit: Option<u32>,
) -> AppResult<Vec<SearchHit>> {
    principal.require_vault(vault_id)?;
    require_member(state, &principal.user.id, vault_id).await?;
    let limit = limit.unwrap_or(20).min(100);
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let backend = state.db.get_database_backend();
    let rows = if query.chars().count() >= 3 {
        state
            .db
            .query_all(Statement::from_sql_and_values(
                backend,
                "SELECT guid,path,title,snippet(note_fts, 5, '<mark>', '</mark>', '...', 12) AS snippet \
                 FROM note_fts WHERE vault_id = ? AND note_fts MATCH ? ORDER BY bm25(note_fts) LIMIT ?",
                [
                    Value::from(vault_id),
                    Value::from(fts_phrase(query)),
                    Value::from(limit as i64),
                ],
            ))
            .await?
    } else {
        let like = format!("%{}%", like_escape(&query.to_ascii_lowercase()));
        state
            .db
            .query_all(Statement::from_sql_and_values(
                backend,
                "SELECT guid,path,title,'' AS snippet FROM note_search \
                 WHERE vault_id = ? AND (lower(path) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\' \
                 OR lower(tags) LIKE ? ESCAPE '\\') LIMIT ?",
                [
                    Value::from(vault_id),
                    Value::from(like.as_str()),
                    Value::from(like.as_str()),
                    Value::from(like.as_str()),
                    Value::from(limit as i64),
                ],
            ))
            .await?
    };
    let mut out = Vec::new();
    for row in rows {
        let guid: String = row.try_get("", "guid")?;
        out.push(SearchHit {
            permalink: permalink_for_guid(state, &guid),
            guid,
            path: row.try_get("", "path")?,
            title: row.try_get("", "title")?,
            snippet: row.try_get("", "snippet")?,
        });
    }
    Ok(out)
}

pub async fn list_tags_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
) -> AppResult<Vec<TagCount>> {
    principal.require_vault(vault_id)?;
    require_member(state, &principal.user.id, vault_id).await?;
    let rows = note_search::Entity::find()
        .filter(note_search::Column::VaultId.eq(vault_id))
        .all(&state.db)
        .await?;
    let mut counts: HashMap<String, u32> = HashMap::new();
    for row in rows {
        if let Ok(tags) = serde_json::from_str::<Vec<String>>(&row.tags) {
            for tag in tags {
                *counts.entry(tag).or_default() += 1;
            }
        }
    }
    let mut out: Vec<_> = counts
        .into_iter()
        .map(|(tag, count)| TagCount { tag, count })
        .collect();
    out.sort_by(|a, b| a.tag.cmp(&b.tag));
    Ok(out)
}

pub async fn list_backlinks_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
) -> AppResult<Vec<SearchHit>> {
    principal.require_vault(vault_id)?;
    require_member(state, &principal.user.id, vault_id).await?;
    let keys = target_keys(path);
    let rows = note_search::Entity::find()
        .filter(note_search::Column::VaultId.eq(vault_id))
        .all(&state.db)
        .await?;
    let mut out = Vec::new();
    for row in rows {
        if row.path == path {
            continue;
        }
        let links = serde_json::from_str::<Vec<String>>(&row.links).unwrap_or_default();
        if links.iter().any(|l| keys.contains(l)) {
            out.push(SearchHit {
                permalink: permalink_for_guid(state, &row.guid),
                guid: row.guid,
                path: row.path,
                title: row.title,
                snippet: String::new(),
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

pub async fn candidate_backlinks(
    state: &AppState,
    vault_id: &str,
    old_path: &str,
) -> AppResult<Vec<note_search::Model>> {
    let term = stem(old_path);
    if term.chars().count() >= 3 {
        let rows = state
            .db
            .query_all(Statement::from_sql_and_values(
                state.db.get_database_backend(),
                "SELECT guid FROM note_fts WHERE vault_id = ? AND note_fts MATCH ? LIMIT 500",
                [Value::from(vault_id), Value::from(fts_phrase(term))],
            ))
            .await?;
        let mut out = Vec::new();
        for row in rows {
            let guid: String = row.try_get("", "guid")?;
            if let Some(model) = note_search::Entity::find()
                .filter(note_search::Column::VaultId.eq(vault_id))
                .filter(note_search::Column::Guid.eq(guid))
                .one(&state.db)
                .await?
            {
                out.push(model);
            }
        }
        Ok(out)
    } else {
        Ok(note_search::Entity::find()
            .filter(note_search::Column::VaultId.eq(vault_id))
            .all(&state.db)
            .await?)
    }
}

pub async fn reindex_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
) -> AppResult<ReindexResponse> {
    principal.require_vault(vault_id)?;
    require_member(state, &principal.user.id, vault_id).await?;
    Ok(ReindexResponse {
        count: reindex_vault(state, vault_id).await?,
    })
}

pub async fn clear_fts_and_reindex_inner(
    state: &AppState,
    principal: &ApiPrincipal,
) -> AppResult<ClearFtsAndReindexResponse> {
    if principal.pinned_vault_id().is_some() {
        return Err(AppError::Forbidden);
    }

    let rows = memberships::Entity::find()
        .filter(memberships::Column::UserId.eq(&principal.user.id))
        .all(&state.db)
        .await?;

    clear_note_fts(state).await?;

    let mut count = 0usize;
    for row in &rows {
        count += reindex_vault(state, &row.vault_id).await?;
    }

    Ok(ClearFtsAndReindexResponse {
        vaults: rows.len(),
        count,
    })
}

pub async fn search_notes(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path(vault_id): Path<String>,
    Query(q): Query<SearchQuery>,
) -> AppResult<Json<Vec<SearchHit>>> {
    Ok(Json(
        search_notes_inner(&state, &principal, &vault_id, &q.q, q.limit).await?,
    ))
}

pub async fn list_tags(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path(vault_id): Path<String>,
) -> AppResult<Json<Vec<TagCount>>> {
    Ok(Json(list_tags_inner(&state, &principal, &vault_id).await?))
}

pub async fn list_backlinks(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
) -> AppResult<Json<Vec<SearchHit>>> {
    Ok(Json(
        list_backlinks_inner(&state, &principal, &vault_id, &path).await?,
    ))
}

pub async fn reindex(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path(vault_id): Path<String>,
) -> AppResult<Json<ReindexResponse>> {
    Ok(Json(reindex_inner(&state, &principal, &vault_id).await?))
}

pub async fn clear_fts_and_reindex(
    State(state): State<AppState>,
    principal: ApiPrincipal,
) -> AppResult<Json<ClearFtsAndReindexResponse>> {
    Ok(Json(clear_fts_and_reindex_inner(&state, &principal).await?))
}

struct VaultState {
    full_reindex: bool,
    dirty_guids: HashSet<String>,
    deadline: Instant,
    running: bool,
}
struct Inner {
    vaults: Mutex<HashMap<String, VaultState>>,
}

#[derive(Clone)]
pub struct SearchService(Arc<Inner>);

const SEARCH_DEBOUNCE: Duration = Duration::from_millis(250);

impl SearchService {
    pub fn new(_config: Arc<Config>) -> Self {
        Self(Arc::new(Inner {
            vaults: Mutex::new(HashMap::new()),
        }))
    }
    /// Reconcile the whole vault after its path-to-guid index changes.
    pub async fn mark_vault_write(&self, state: AppState, vault_id: &str) {
        self.mark_write(state, vault_id, None).await;
    }

    /// Refresh one changed note without rereading every document in the vault.
    pub async fn mark_note_write(&self, state: AppState, vault_id: &str, guid: &str) {
        self.mark_write(state, vault_id, Some(guid)).await;
    }

    async fn mark_write(&self, state: AppState, vault_id: &str, guid: Option<&str>) {
        let mut vaults = self.0.vaults.lock().await;
        let entry = vaults
            .entry(vault_id.to_string())
            .or_insert_with(|| VaultState {
                full_reindex: false,
                dirty_guids: HashSet::new(),
                deadline: Instant::now(),
                running: false,
            });
        if let Some(guid) = guid {
            if !entry.full_reindex {
                entry.dirty_guids.insert(guid.to_string());
            }
        } else {
            entry.full_reindex = true;
            entry.dirty_guids.clear();
        }
        entry.deadline = Instant::now() + SEARCH_DEBOUNCE;
        if !entry.running {
            entry.running = true;
            let svc = self.clone();
            let vault_id = vault_id.to_string();
            tokio::spawn(async move { svc.run_vault(state, vault_id).await });
        }
    }
    async fn run_vault(self, state: AppState, vault_id: String) {
        loop {
            loop {
                let remaining = {
                    self.0
                        .vaults
                        .lock()
                        .await
                        .get(&vault_id)
                        .and_then(|s| s.deadline.checked_duration_since(Instant::now()))
                };
                match remaining {
                    Some(d) => tokio::time::sleep(d).await,
                    None => break,
                }
            }
            let (full_reindex, dirty_guids) = {
                let mut vaults = self.0.vaults.lock().await;
                if let Some(s) = vaults.get_mut(&vault_id) {
                    if !s.full_reindex && s.dirty_guids.is_empty() {
                        s.running = false;
                        return;
                    }
                    let full_reindex = std::mem::take(&mut s.full_reindex);
                    let dirty_guids = std::mem::take(&mut s.dirty_guids);
                    (full_reindex, dirty_guids)
                } else {
                    return;
                }
            };
            if full_reindex {
                if let Err(e) = reindex_vault(&state, &vault_id).await {
                    tracing::error!("search reindex for vault {vault_id} failed: {e}");
                }
            } else {
                for guid in dirty_guids {
                    if let Err(e) = reindex_note(&state, &vault_id, &guid).await {
                        tracing::error!(
                            "search index refresh for vault {vault_id} note {guid} failed: {e}"
                        );
                    }
                }
            }
            {
                let mut vaults = self.0.vaults.lock().await;
                if let Some(s) = vaults.get_mut(&vault_id) {
                    if !s.full_reindex && s.dirty_guids.is_empty() {
                        s.running = false;
                        return;
                    }
                } else {
                    return;
                }
            }
        }
    }
}

async fn reindex_note(state: &AppState, vault_id: &str, guid: &str) -> AppResult<()> {
    let indexed = note_search::Entity::find()
        .filter(note_search::Column::VaultId.eq(vault_id))
        .filter(note_search::Column::Guid.eq(guid))
        .one(&state.db)
        .await?;
    let path = if let Some(indexed) = indexed {
        indexed.path
    } else {
        let update = ydoc::read_update(state, vault_id).await?;
        let files =
            ydoc::decode_files_map(&update).map_err(|e| AppError::Internal(e.to_string()))?;
        let Some((path, _)) = files.into_iter().find(|(_, candidate)| candidate == guid) else {
            return remove_note(state, vault_id, guid).await;
        };
        path
    };
    let update = ydoc::read_update(state, &format!("{vault_id}__{guid}")).await?;
    let content =
        ydoc::decode_text(&update, "contents").map_err(|e| AppError::Internal(e.to_string()))?;
    index_note(state, vault_id, guid, &path, &content).await
}

pub fn spawn_startup_backfill(state: AppState) {
    tokio::spawn(async move {
        match vaults::Entity::find().all(&state.db).await {
            Ok(vaults) => {
                let mut failed = 0usize;
                for v in vaults {
                    if let Err(e) = reindex_vault_with_startup_retries(&state, &v.id).await {
                        failed += 1;
                        tracing::debug!("startup search reindex {} skipped: {e}", v.id);
                    }
                }
                if failed > 0 {
                    tracing::warn!(
                        "startup search reindex skipped {failed} vault(s); they will reindex on the next change or manual reindex"
                    );
                }
            }
            Err(e) => tracing::warn!("startup search vault scan failed: {e}"),
        }
    });
}

async fn reindex_vault_with_startup_retries(state: &AppState, vault_id: &str) -> AppResult<usize> {
    let mut last_err = None;
    for delay in [
        Duration::from_secs(2),
        Duration::from_secs(5),
        Duration::from_secs(10),
    ] {
        match reindex_vault(state, vault_id).await {
            Ok(count) => return Ok(count),
            Err(e) => {
                last_err = Some(e);
                tokio::time::sleep(delay).await;
            }
        }
    }
    reindex_vault(state, vault_id)
        .await
        .map_err(|e| last_err.unwrap_or(e))
}

fn frontmatter_value(content: &str) -> Option<serde_json::Value> {
    let rest = content.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    serde_yaml::from_str(&rest[..end]).ok()
}

fn collect_yaml_tags(v: &serde_json::Value, tags: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) => {
            for tag in s.split_whitespace() {
                tags.push(tag.trim_start_matches('#').to_ascii_lowercase());
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                if let Some(s) = item.as_str() {
                    tags.push(s.trim_start_matches('#').to_ascii_lowercase());
                }
            }
        }
        _ => {}
    }
}

fn push_link_keys(out: &mut Vec<String>, target: &str) {
    out.extend(target_keys(target));
}

pub fn target_keys(path: &str) -> HashSet<String> {
    let mut keys = HashSet::new();
    keys.insert(normalize_key(path));
    keys.insert(normalize_key(stem(path)));
    keys
}

fn normalize_key(value: &str) -> String {
    value.trim().trim_end_matches(".md").to_ascii_lowercase()
}

fn normalize_path_for_rewrite(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_ascii_lowercase()
}

fn eq_basename(a: &str, b: &str, is_note: bool) -> bool {
    let a = a.rsplit(['/', '\\']).next().unwrap_or(a);
    let b = b.rsplit(['/', '\\']).next().unwrap_or(b);
    if is_note {
        a.trim_end_matches(".md")
            .eq_ignore_ascii_case(b.trim_end_matches(".md"))
    } else {
        a.eq_ignore_ascii_case(b)
    }
}

fn is_url_like(target: &str) -> bool {
    if target.starts_with("//") {
        return true;
    }
    let mut chars = target.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    for ch in chars {
        if ch == ':' {
            return true;
        }
        if !(ch.is_ascii_alphanumeric() || matches!(ch, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

fn stem(path: &str) -> &str {
    path.rsplit('/')
        .next()
        .unwrap_or(path)
        .trim_end_matches(".md")
}

/// Wrap a user query as a single FTS5 string token so its contents are matched
/// literally instead of being parsed as an FTS5 query expression (which would
/// error on bare `"`, `*`, `:`, `-`, `OR`, etc.). With the trigram tokenizer
/// this yields substring matching.
fn fts_phrase(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// Escape LIKE wildcards so a query's `%`/`_`/`\` are matched literally
/// (paired with `ESCAPE '\'` in the query).
fn like_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn permalink_for_guid(state: &AppState, guid: &str) -> String {
    format!(
        "{}/n/{guid}",
        state.config.public_base_url.trim_end_matches('/')
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_title_tags_and_links() {
        let content = "---\ntitle: Custom\ntags: [Project, '#rust']\n---\n#body #inline\n[[Note]] [[dir/Other.md|Alias]] ![[Embed#h]] [txt](deep/Target.md#x)";
        let parsed = parse_note(content, "Fallback.md");
        assert_eq!(parsed.title, "Custom");
        assert!(parsed.tags.contains(&"project".into()));
        assert!(parsed.tags.contains(&"rust".into()));
        assert!(parsed.tags.contains(&"inline".into()));
        assert!(parsed.links.contains(&"note".into()));
        assert!(parsed.links.contains(&"dir/other".into()));
        assert!(parsed.links.contains(&"other".into()));
        assert!(parsed.links.contains(&"embed".into()));
        assert!(parsed.links.contains(&"deep/target".into()));
    }

    #[test]
    fn rewrites_all_link_forms() {
        let content = "[[Old]] [[Old#h|Alias]] ![[dir/Old.md]] [txt](dir/Old.md#h) [[Other]]";
        let (out, changed) = rewrite_links(content, "dir/Old.md", "new/New.md");
        assert!(changed);
        assert_eq!(
            out,
            "[[New]] [[New#h|Alias]] ![[new/New.md]] [txt](new/New.md#h) [[Other]]"
        );
    }

    #[test]
    fn rewrites_note_targets_preserving_path_form() {
        let content = "[[dir/Old.md]] [[dir/Old]] [[Old.md]] [[Old]]";
        let (out, changed) = rewrite_links(content, "dir/Old.md", "new/New.md");
        assert!(changed);
        assert_eq!(out, "[[new/New.md]] [[new/New]] [[New.md]] [[New]]");
    }

    #[test]
    fn rewrites_attachment_embeds_only_when_text_changes() {
        let (out, changed) = rewrite_links("![[old/img.png]]", "old/img.png", "new/img.png");
        assert!(changed);
        assert_eq!(out, "![[new/img.png]]");

        let (out, changed) = rewrite_links("![[img.png]]", "old/img.png", "new/img.png");
        assert!(!changed);
        assert_eq!(out, "![[img.png]]");
    }

    #[test]
    fn rewrites_markdown_attachment_targets() {
        let content = "![](old/img.png) [file](old/img.png)";
        let (out, changed) = rewrite_links(content, "old/img.png", "new/img.png");
        assert!(changed);
        assert_eq!(out, "![](new/img.png) [file](new/img.png)");
    }

    #[test]
    fn skips_url_like_markdown_targets() {
        let content = "[ext](https://example.com/x) [rel](//host/path)";
        let (out, changed) = rewrite_links(content, "x", "y");
        assert!(!changed);
        assert_eq!(out, content);
    }

    #[test]
    fn preserves_headers_and_aliases() {
        let content = "[[Old#h|Alias]] [txt](dir/Old.md#h)";
        let (out, changed) = rewrite_links(content, "dir/Old.md", "new/New.md");
        assert!(changed);
        assert_eq!(out, "[[New#h|Alias]] [txt](new/New.md#h)");
    }
}
