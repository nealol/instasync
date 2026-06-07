use axum::extract::{Path, State};
use axum::Json;
use chrono::{Datelike, NaiveDate};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value};

use crate::entities::vault_files;
use crate::error::{AppError, AppResult};
use crate::routes::{authorize_doc, require_member};
use crate::session::{now_millis, ApiPrincipal};
use crate::state::AppState;
use crate::ydoc;
use crate::ysweet::{ensure_doc, Level};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub path: String,
    pub guid: String,
    pub permalink: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteResponse {
    pub path: String,
    pub guid: String,
    pub content: String,
    pub permalink: String,
}

#[derive(Deserialize)]
pub struct CreateNoteBody {
    pub path: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Deserialize)]
pub struct ReplaceNoteBody {
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchNoteBody {
    pub old: String,
    pub new: String,
    #[serde(default)]
    pub replace_all: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveNoteBody {
    pub to_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterResponse {
    pub path: String,
    pub frontmatter: Value,
}

#[derive(Deserialize)]
pub struct PatchFrontmatterBody {
    #[serde(default)]
    pub set: JsonMap<String, Value>,
    #[serde(default)]
    pub unset: Vec<String>,
}

#[derive(Deserialize)]
pub struct PeriodicPath {
    pub id: String,
    pub period: String,
}

#[derive(Deserialize)]
pub struct PeriodicBody {
    pub date: Option<String>,
    #[serde(default)]
    pub content: String,
}

#[derive(Deserialize)]
pub struct PeriodicAppendBody {
    pub date: Option<String>,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermalinkResponse {
    pub kind: String,
    pub url: String,
}

pub async fn list_notes(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path(vault_id): Path<String>,
) -> AppResult<Json<Vec<NoteSummary>>> {
    Ok(Json(list_notes_inner(&state, &principal, &vault_id).await?))
}

pub(crate) async fn list_notes_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
) -> AppResult<Vec<NoteSummary>> {
    principal.require_vault(vault_id)?;
    require_member(state, &principal.user.id, vault_id).await?;

    // The y-sweet index doc is the source of truth for which files exist; the
    // `vault_files` table is a server-side mirror. Reconcile before listing so
    // files deleted on a client (which only removes them from the index doc,
    // never calling the server delete API) don't surface as ghost notes.
    let mut files = reconcile_vault_files(state, vault_id).await?;
    files.sort_by(|a, b| a.0.cmp(&b.0));

    Ok(files
        .into_iter()
        .map(|(path, guid)| NoteSummary {
            permalink: permalink_for_guid(state, &guid),
            path,
            guid,
        })
        .collect())
}

/// Reconcile the `vault_files` registry against the authoritative y-sweet index
/// doc (`files` map of path -> guid), returning the live `(path, guid)` entries.
///
/// Clients propagate deletions/renames only through the index doc's CRDT, so the
/// DB registry drifts: deleted files leave orphan rows ("ghosts") and renamed
/// files leave stale paths. We prune orphan rows and upsert missing/stale ones
/// so the registry mirrors reality. The index doc is trusted as truth here, the
/// same way the git audit service materializes commits from it.
pub(crate) async fn reconcile_vault_files(
    state: &AppState,
    vault_id: &str,
) -> AppResult<Vec<(String, String)>> {
    let update = ydoc::read_update(state, vault_id).await?;
    // (path, guid) entries from the live index doc.
    let index = ydoc::decode_files_map(&update).map_err(|e| AppError::Internal(e.to_string()))?;

    let rows = vault_files::Entity::find()
        .filter(vault_files::Column::VaultId.eq(vault_id))
        .all(&state.db)
        .await?;

    let row_tuples: Vec<(String, String, String)> = rows
        .iter()
        .map(|r| (r.id.clone(), r.guid.clone(), r.path.clone()))
        .collect();
    let (delete_ids, upserts) = plan_reconcile(&index, &row_tuples);

    for id in delete_ids {
        vault_files::Entity::delete_by_id(id).exec(&state.db).await?;
    }
    for (path, guid) in upserts {
        ydoc::upsert_vault_file(state, vault_id, &path, &guid).await?;
    }

    Ok(index)
}

/// Pure planner for {@link reconcile_vault_files}: given the live index entries
/// (`path`, `guid`) and the existing DB rows (`id`, `guid`, `path`), decide
/// which row ids to delete (orphans) and which `(path, guid)` to upsert (missing
/// or stale-path rows).
fn plan_reconcile(
    index: &[(String, String)],
    rows: &[(String, String, String)],
) -> (Vec<String>, Vec<(String, String)>) {
    use std::collections::{HashMap, HashSet};

    let live_guids: HashSet<&str> = index.iter().map(|(_, guid)| guid.as_str()).collect();
    let row_path_by_guid: HashMap<&str, &str> =
        rows.iter().map(|(_, guid, path)| (guid.as_str(), path.as_str())).collect();

    let delete_ids = rows
        .iter()
        .filter(|(_, guid, _)| !live_guids.contains(guid.as_str()))
        .map(|(id, _, _)| id.clone())
        .collect();

    let upserts = index
        .iter()
        .filter(|(path, guid)| row_path_by_guid.get(guid.as_str()) != Some(&path.as_str()))
        .map(|(path, guid)| (path.clone(), guid.clone()))
        .collect();

    (delete_ids, upserts)
}

pub async fn create_note(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path(vault_id): Path<String>,
    Json(body): Json<CreateNoteBody>,
) -> AppResult<Json<NoteResponse>> {
    Ok(Json(
        create_note_inner(&state, &principal, &vault_id, body).await?,
    ))
}

pub(crate) async fn create_note_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    body: CreateNoteBody,
) -> AppResult<NoteResponse> {
    principal.require_vault(vault_id)?;
    require_member(state, &principal.user.id, vault_id).await?;
    validate_note_path(&body.path)?;

    if file_by_path(state, vault_id, &body.path).await?.is_some() {
        return Err(AppError::Conflict("note already exists".into()));
    }

    let guid = uuid::Uuid::new_v4().to_string();
    let doc_id = doc_id(vault_id, &guid);
    ensure_doc(state, &doc_id).await?;
    ydoc::set_text(state, &doc_id, &body.content).await?;
    ydoc::index_set_file(state, vault_id, &body.path, &guid).await?;
    best_effort_index(state, vault_id, &guid, &body.path, &body.content).await;
    state
        .git
        .mark_write(
            vault_id,
            &principal.to_git_principal(now_millis() + 24 * 60 * 60 * 1000),
        )
        .await;

    Ok(NoteResponse {
        permalink: permalink_for_guid(state, &guid),
        path: body.path,
        guid,
        content: body.content,
    })
}

pub async fn read_note(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
) -> AppResult<Json<NoteResponse>> {
    Ok(Json(
        read_note_inner(&state, &principal, &vault_id, &path).await?,
    ))
}

pub(crate) async fn read_note_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
) -> AppResult<NoteResponse> {
    let file = require_note_access(state, principal, vault_id, path, false).await?;
    let doc_id = doc_id(vault_id, &file.guid);
    let update = ydoc::read_update(state, &doc_id).await?;
    let content =
        ydoc::decode_text(&update, "contents").map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(NoteResponse {
        permalink: permalink_for_guid(state, &file.guid),
        path: file.path,
        guid: file.guid,
        content,
    })
}

pub async fn replace_note(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<ReplaceNoteBody>,
) -> AppResult<Json<NoteResponse>> {
    Ok(Json(
        replace_note_inner(&state, &principal, &vault_id, &path, body).await?,
    ))
}

pub(crate) async fn replace_note_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    body: ReplaceNoteBody,
) -> AppResult<NoteResponse> {
    let file = require_note_access(state, principal, vault_id, path, true).await?;
    let doc_id = doc_id(vault_id, &file.guid);
    ydoc::set_text(state, &doc_id, &body.content).await?;
    best_effort_index(state, vault_id, &file.guid, &file.path, &body.content).await;
    state
        .git
        .mark_write(
            vault_id,
            &principal.to_git_principal(now_millis() + 24 * 60 * 60 * 1000),
        )
        .await;

    Ok(NoteResponse {
        permalink: permalink_for_guid(state, &file.guid),
        path: file.path,
        guid: file.guid,
        content: body.content,
    })
}

pub async fn patch_note(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<PatchNoteBody>,
) -> AppResult<Json<NoteResponse>> {
    Ok(Json(
        patch_note_inner(&state, &principal, &vault_id, &path, body).await?,
    ))
}

pub(crate) async fn patch_note_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    body: PatchNoteBody,
) -> AppResult<NoteResponse> {
    if body.old.is_empty() {
        return Err(AppError::BadRequest("old text is required".into()));
    }
    let file = require_note_access(state, principal, vault_id, path, true).await?;
    let doc_id = doc_id(vault_id, &file.guid);
    let update = ydoc::read_update(state, &doc_id).await?;
    let content =
        ydoc::decode_text(&update, "contents").map_err(|e| AppError::Internal(e.to_string()))?;
    let matches = content.matches(&body.old).count();
    if matches == 0 {
        return Err(AppError::BadRequest("anchor_not_found".into()));
    }
    if matches > 1 && !body.replace_all {
        return Err(AppError::Conflict("ambiguous".into()));
    }

    let new_content = if body.replace_all {
        content.replace(&body.old, &body.new)
    } else {
        content.replacen(&body.old, &body.new, 1)
    };
    if new_content == content {
        return Err(AppError::Conflict("no_op".into()));
    }

    ydoc::set_text(state, &doc_id, &new_content).await?;
    best_effort_index(state, vault_id, &file.guid, &file.path, &new_content).await;
    mark_note_write(state, vault_id, principal).await;
    Ok(NoteResponse {
        permalink: permalink_for_guid(state, &file.guid),
        path: file.path,
        guid: file.guid,
        content: new_content,
    })
}

pub async fn move_note(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<MoveNoteBody>,
) -> AppResult<Json<NoteResponse>> {
    Ok(Json(
        move_note_inner(&state, &principal, &vault_id, &path, body).await?,
    ))
}

pub(crate) async fn move_note_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    body: MoveNoteBody,
) -> AppResult<NoteResponse> {
    validate_note_path(&body.to_path)?;
    if path == body.to_path {
        return Err(AppError::Conflict("same_path".into()));
    }
    let file = require_note_access(state, principal, vault_id, path, true).await?;
    if file_by_path(state, vault_id, &body.to_path)
        .await?
        .is_some()
    {
        return Err(AppError::Conflict("exists".into()));
    }

    ydoc::index_rename(state, vault_id, &file.path, &body.to_path).await?;
    let doc_id = doc_id(vault_id, &file.guid);
    let update = ydoc::read_update(state, &doc_id).await?;
    let content =
        ydoc::decode_text(&update, "contents").map_err(|e| AppError::Internal(e.to_string()))?;
    best_effort_index(state, vault_id, &file.guid, &body.to_path, &content).await;
    rewrite_backlinks_after_move(state, vault_id, &file.guid, &file.path, &body.to_path).await;
    mark_note_write(state, vault_id, principal).await;
    Ok(NoteResponse {
        permalink: permalink_for_guid(state, &file.guid),
        path: body.to_path,
        guid: file.guid,
        content,
    })
}

pub async fn delete_note(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
) -> AppResult<Json<serde_json::Value>> {
    delete_note_inner(&state, &principal, &vault_id, &path).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn delete_note_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
) -> AppResult<()> {
    let file = require_note_access(state, principal, vault_id, path, true).await?;
    ydoc::index_remove_file(state, vault_id, &file.path).await?;
    if let Err(e) = crate::search::remove_note(state, vault_id, &file.guid).await {
        tracing::warn!("search remove failed for {}: {e}", file.path);
    }
    mark_note_write(state, vault_id, principal).await;
    Ok(())
}

async fn mark_note_write(state: &AppState, vault_id: &str, principal: &ApiPrincipal) {
    let git_principal = principal.to_git_principal(now_millis() + 24 * 60 * 60 * 1000);
    state
        .git
        .mark_write(vault_id, &git_principal)
        .await;
    state
        .search
        .mark_write(state.clone(), vault_id, &git_principal)
        .await;
}

async fn best_effort_index(
    state: &AppState,
    vault_id: &str,
    guid: &str,
    path: &str,
    content: &str,
) {
    if let Err(e) = crate::search::index_note(state, vault_id, guid, path, content).await {
        tracing::warn!("search index failed for {path}: {e}");
    }
}

async fn rewrite_backlinks_after_move(
    state: &AppState,
    vault_id: &str,
    moved_guid: &str,
    old_path: &str,
    new_path: &str,
) {
    match crate::search::candidate_backlinks(state, vault_id, old_path).await {
        Ok(candidates) => {
            let mut count = 0usize;
            for cand in candidates {
                if cand.guid == moved_guid {
                    continue;
                }
                let doc_id = doc_id(vault_id, &cand.guid);
                let update = match ydoc::read_update(state, &doc_id).await {
                    Ok(update) => update,
                    Err(e) => {
                        tracing::warn!("read backlink candidate {} failed: {e}", cand.path);
                        continue;
                    }
                };
                let content = match ydoc::decode_text(&update, "contents") {
                    Ok(content) => content,
                    Err(e) => {
                        tracing::warn!("decode backlink candidate {} failed: {e}", cand.path);
                        continue;
                    }
                };
                let (new_content, changed) = crate::search::rewrite_links(&content, old_path, new_path);
                if changed {
                    if let Err(e) = ydoc::set_text(state, &doc_id, &new_content).await {
                        tracing::warn!("rewrite backlink {} failed: {e}", cand.path);
                        continue;
                    }
                    best_effort_index(state, vault_id, &cand.guid, &cand.path, &new_content).await;
                    count += 1;
                }
            }
            if count > 0 {
                tracing::info!("rewrote {count} backlinks for note move {old_path} -> {new_path}");
            }
        }
        Err(e) => tracing::warn!("backlink candidate search failed for {old_path}: {e}"),
    }
}

pub async fn note_permalink(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
) -> AppResult<Json<PermalinkResponse>> {
    Ok(Json(
        note_permalink_inner(&state, &principal, &vault_id, &path).await?,
    ))
}

pub(crate) async fn note_permalink_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
) -> AppResult<PermalinkResponse> {
    let file = require_note_access(state, principal, vault_id, path, false).await?;
    Ok(PermalinkResponse {
        kind: "id".into(),
        url: permalink_for_guid(state, &file.guid),
    })
}

pub async fn parse_frontmatter(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
) -> AppResult<Json<FrontmatterResponse>> {
    Ok(Json(
        parse_frontmatter_inner(&state, &principal, &vault_id, &path).await?,
    ))
}

pub(crate) async fn parse_frontmatter_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
) -> AppResult<FrontmatterResponse> {
    let (file, content) = read_note_content(state, principal, vault_id, path, false).await?;
    Ok(FrontmatterResponse {
        path: file.path,
        frontmatter: parse_frontmatter_value(&content)?,
    })
}

pub async fn patch_frontmatter(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<PatchFrontmatterBody>,
) -> AppResult<Json<NoteResponse>> {
    Ok(Json(
        patch_frontmatter_inner(&state, &principal, &vault_id, &path, body).await?,
    ))
}

pub(crate) async fn patch_frontmatter_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    body: PatchFrontmatterBody,
) -> AppResult<NoteResponse> {
    let (file, content) = read_note_content(state, principal, vault_id, path, true).await?;
    let new_content = patch_frontmatter_content(&content, body)?;
    let doc_id = doc_id(vault_id, &file.guid);
    ydoc::set_text(state, &doc_id, &new_content).await?;
    best_effort_index(state, vault_id, &file.guid, &file.path, &new_content).await;
    mark_note_write(state, vault_id, principal).await;
    Ok(NoteResponse {
        permalink: permalink_for_guid(state, &file.guid),
        path: file.path,
        guid: file.guid,
        content: new_content,
    })
}

pub(crate) async fn replace_body_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    body: String,
) -> AppResult<NoteResponse> {
    let (file, content) = read_note_content(state, principal, vault_id, path, true).await?;
    let new_content = if let Some((_yaml, body_start)) = frontmatter_bounds(&content) {
        format!("{}{}", &content[..body_start], body)
    } else {
        body
    };
    ydoc::set_text(state, &doc_id(vault_id, &file.guid), &new_content).await?;
    best_effort_index(state, vault_id, &file.guid, &file.path, &new_content).await;
    mark_note_write(state, vault_id, principal).await;
    Ok(NoteResponse {
        permalink: permalink_for_guid(state, &file.guid),
        path: file.path,
        guid: file.guid,
        content: new_content,
    })
}

pub async fn periodic_note_get_or_create(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path(path): Path<PeriodicPath>,
    Json(body): Json<PeriodicBody>,
) -> AppResult<Json<NoteResponse>> {
    Ok(Json(
        periodic_note_get_or_create_inner(&state, &principal, &path.id, &path.period, body).await?,
    ))
}

pub(crate) async fn periodic_note_get_or_create_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    period: &str,
    body: PeriodicBody,
) -> AppResult<NoteResponse> {
    principal.require_vault(vault_id)?;
    require_member(state, &principal.user.id, vault_id).await?;
    let note_path = periodic_path(state, period, body.date.as_deref())?;
    if let Some(file) = file_by_path(state, vault_id, &note_path).await? {
        // Honor per-path ACLs on the existing periodic note (deny -> Forbidden).
        authorize_doc(state, &principal.user, vault_id, &doc_id(vault_id, &file.guid)).await?;
        let update = ydoc::read_update(state, &doc_id(vault_id, &file.guid)).await?;
        let content = ydoc::decode_text(&update, "contents")
            .map_err(|e| AppError::Internal(e.to_string()))?;
        return Ok(NoteResponse {
            permalink: permalink_for_guid(state, &file.guid),
            path: file.path,
            guid: file.guid,
            content,
        });
    }

    validate_note_path(&note_path)?;
    let guid = uuid::Uuid::new_v4().to_string();
    let doc_id = doc_id(vault_id, &guid);
    ensure_doc(state, &doc_id).await?;
    ydoc::set_text(state, &doc_id, &body.content).await?;
    ydoc::index_set_file(state, vault_id, &note_path, &guid).await?;
    best_effort_index(state, vault_id, &guid, &note_path, &body.content).await;
    mark_note_write(state, vault_id, principal).await;
    Ok(NoteResponse {
        permalink: permalink_for_guid(state, &guid),
        path: note_path,
        guid,
        content: body.content,
    })
}

pub async fn periodic_note_append(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path(path): Path<PeriodicPath>,
    Json(body): Json<PeriodicAppendBody>,
) -> AppResult<Json<NoteResponse>> {
    Ok(Json(
        periodic_note_append_inner(&state, &principal, &path.id, &path.period, body).await?,
    ))
}

pub(crate) async fn periodic_note_append_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    period: &str,
    body: PeriodicAppendBody,
) -> AppResult<NoteResponse> {
    let get_body = PeriodicBody {
        date: body.date.clone(),
        content: String::new(),
    };
    let existing =
        periodic_note_get_or_create_inner(state, principal, vault_id, period, get_body).await?;
    let file = file_by_path(state, vault_id, &existing.path)
        .await?
        .ok_or(AppError::NotFound)?;
    // Appending is a write; reject when the per-path ACL is read-only or deny.
    let level = authorize_doc(state, &principal.user, vault_id, &doc_id(vault_id, &file.guid)).await?;
    if level == Level::ReadOnly {
        return Err(AppError::Forbidden);
    }
    let mut content = existing.content;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&body.text);
    ydoc::set_text(state, &doc_id(vault_id, &file.guid), &content).await?;
    best_effort_index(state, vault_id, &file.guid, &existing.path, &content).await;
    mark_note_write(state, vault_id, principal).await;
    Ok(NoteResponse {
        permalink: permalink_for_guid(state, &file.guid),
        path: existing.path,
        guid: file.guid,
        content,
    })
}

async fn read_note_content(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    write: bool,
) -> AppResult<(vault_files::Model, String)> {
    let file = require_note_access(state, principal, vault_id, path, write).await?;
    let update = ydoc::read_update(state, &doc_id(vault_id, &file.guid)).await?;
    let content =
        ydoc::decode_text(&update, "contents").map_err(|e| AppError::Internal(e.to_string()))?;
    Ok((file, content))
}

async fn require_note_access(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    write: bool,
) -> AppResult<vault_files::Model> {
    principal.require_vault(vault_id)?;
    require_member(state, &principal.user.id, vault_id).await?;
    validate_note_path(path)?;
    let file = file_by_path(state, vault_id, path)
        .await?
        .ok_or(AppError::NotFound)?;
    let level = authorize_doc(
        state,
        &principal.user,
        vault_id,
        &doc_id(vault_id, &file.guid),
    )
    .await?;
    if write && level == Level::ReadOnly {
        return Err(AppError::Forbidden);
    }
    Ok(file)
}

async fn file_by_path(
    state: &AppState,
    vault_id: &str,
    path: &str,
) -> AppResult<Option<vault_files::Model>> {
    Ok(vault_files::Entity::find()
        .filter(vault_files::Column::VaultId.eq(vault_id))
        .filter(vault_files::Column::Path.eq(path))
        .one(&state.db)
        .await?)
}

fn validate_note_path(path: &str) -> AppResult<()> {
    if path.is_empty() || path.contains('\\') || !path.ends_with(".md") {
        return Err(AppError::BadRequest("invalid note path".into()));
    }
    for component in path.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(AppError::BadRequest("invalid note path".into()));
        }
    }
    Ok(())
}

fn doc_id(vault_id: &str, guid: &str) -> String {
    format!("{vault_id}__{guid}")
}

fn permalink_for_guid(state: &AppState, guid: &str) -> String {
    format!(
        "{}/n/{guid}",
        state.config.public_base_url.trim_end_matches('/')
    )
}

fn periodic_path(state: &AppState, period: &str, date: Option<&str>) -> AppResult<String> {
    let date = match date {
        Some(value) => NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .map_err(|_| AppError::BadRequest("invalid date".into()))?,
        None => chrono::Local::now().date_naive(),
    };
    let template = match period {
        "daily" => Some(state.config.daily_note_path_template.as_str()),
        "weekly" => state.config.weekly_note_path_template.as_deref(),
        "monthly" => state.config.monthly_note_path_template.as_deref(),
        "quarterly" => state.config.quarterly_note_path_template.as_deref(),
        "yearly" => state.config.yearly_note_path_template.as_deref(),
        _ => return Err(AppError::BadRequest("invalid period".into())),
    }
    .ok_or_else(|| AppError::BadRequest("period_not_configured".into()))?;
    Ok(render_periodic_template(template, date))
}

fn render_periodic_template(template: &str, date: NaiveDate) -> String {
    let iso = date.iso_week();
    let quarter = (date.month0() / 3) + 1;
    template
        .replace("{{YYYY-MM-DD}}", &date.format("%Y-%m-%d").to_string())
        .replace("{{YYYY}}", &format!("{:04}", date.year()))
        .replace("{{MM}}", &format!("{:02}", date.month()))
        .replace("{{DD}}", &format!("{:02}", date.day()))
        .replace("{{Q}}", &quarter.to_string())
        .replace("{{WW}}", &format!("{:02}", iso.week()))
        .replace("{{GGGG}}", &format!("{:04}", iso.year()))
}

fn parse_frontmatter_value(content: &str) -> AppResult<Value> {
    let Some((yaml, _body_start)) = frontmatter_bounds(content) else {
        return Ok(Value::Object(JsonMap::new()));
    };
    let parsed: Value = serde_yaml::from_str(yaml)
        .map_err(|e| AppError::BadRequest(format!("invalid frontmatter: {e}")))?;
    Ok(parsed
        .as_object()
        .cloned()
        .map(Value::Object)
        .unwrap_or(Value::Object(JsonMap::new())))
}

fn patch_frontmatter_content(content: &str, patch: PatchFrontmatterBody) -> AppResult<String> {
    let (existing, body_start) = match frontmatter_bounds(content) {
        Some((yaml, body_start)) => (yaml, body_start),
        None => ("", 0),
    };
    let mut map = match serde_yaml::from_str::<Value>(existing) {
        Ok(Value::Object(map)) => map,
        Ok(_) | Err(_) => JsonMap::new(),
    };
    for key in patch.unset {
        map.remove(&key);
    }
    for (key, value) in patch.set {
        map.insert(key, value);
    }
    let body = &content[body_start..];
    // An empty map means no frontmatter — emit the bare body rather than `---\n{}\n---`.
    if map.is_empty() {
        return Ok(body.to_string());
    }
    let yaml = serde_yaml::to_string(&Value::Object(map))
        .map_err(|e| AppError::Internal(format!("serialize frontmatter: {e}")))?;
    Ok(format!("---\n{}\n---\n{}", yaml.trim_end(), body))
}

fn frontmatter_bounds(content: &str) -> Option<(&str, usize)> {
    let rest = content.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    let yaml = &rest[..end];
    let after_marker = 4 + end + "\n---".len();
    let body_start = if content[after_marker..].starts_with('\n') {
        after_marker + 1
    } else {
        after_marker
    };
    Some((yaml, body_start))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idx(entries: &[(&str, &str)]) -> Vec<(String, String)> {
        entries
            .iter()
            .map(|(path, guid)| (path.to_string(), guid.to_string()))
            .collect()
    }

    fn rows(entries: &[(&str, &str, &str)]) -> Vec<(String, String, String)> {
        entries
            .iter()
            .map(|(id, guid, path)| (id.to_string(), guid.to_string(), path.to_string()))
            .collect()
    }

    #[test]
    fn prunes_ghost_rows_absent_from_index() {
        // "a" still exists; "ghost" was deleted on a client (gone from the index).
        let index = idx(&[("a.md", "guid-a")]);
        let db = rows(&[("1", "guid-a", "a.md"), ("2", "guid-ghost", "Seed.md")]);

        let (delete_ids, upserts) = plan_reconcile(&index, &db);

        assert_eq!(delete_ids, vec!["2".to_string()]);
        assert!(upserts.is_empty());
    }

    #[test]
    fn upserts_missing_and_stale_path_rows() {
        // "a" missing from DB entirely; "b" present but with an outdated path.
        let index = idx(&[("a.md", "guid-a"), ("new/b.md", "guid-b")]);
        let db = rows(&[("2", "guid-b", "old/b.md")]);

        let (delete_ids, mut upserts) = plan_reconcile(&index, &db);
        upserts.sort();

        assert!(delete_ids.is_empty());
        assert_eq!(
            upserts,
            vec![
                ("a.md".to_string(), "guid-a".to_string()),
                ("new/b.md".to_string(), "guid-b".to_string()),
            ]
        );
    }

    #[test]
    fn no_op_when_registry_matches_index() {
        let index = idx(&[("a.md", "guid-a"), ("dir/b.md", "guid-b")]);
        let db = rows(&[("1", "guid-a", "a.md"), ("2", "guid-b", "dir/b.md")]);

        let (delete_ids, upserts) = plan_reconcile(&index, &db);

        assert!(delete_ids.is_empty());
        assert!(upserts.is_empty());
    }

    #[test]
    fn empty_index_prunes_all_rows() {
        let index = idx(&[]);
        let db = rows(&[("1", "guid-a", "a.md"), ("2", "guid-b", "b.md")]);

        let (mut delete_ids, upserts) = plan_reconcile(&index, &db);
        delete_ids.sort();

        assert_eq!(delete_ids, vec!["1".to_string(), "2".to_string()]);
        assert!(upserts.is_empty());
    }
}
