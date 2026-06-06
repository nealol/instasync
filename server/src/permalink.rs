use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Redirect, Response};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::Deserialize;

use crate::entities::vault_files;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub async fn note_by_guid(
    State(state): State<AppState>,
    Path(guid): Path<String>,
) -> AppResult<Redirect> {
    if guid.is_empty() {
        return Err(AppError::BadRequest("invalid guid".into()));
    }
    let file = vault_files::Entity::find()
        .filter(vault_files::Column::Guid.eq(&guid))
        .one(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    // NB: use `vaultId`, not `vault` — Obsidian reserves the `vault` query
    // parameter and resolves it to a local Obsidian vault before dispatching to
    // our protocol handler, failing with "Unable to find a vault for the URL".
    Ok(Redirect::temporary(&format!(
        "obsidian://instasync-open?vaultId={}&guid={}",
        encode_component(&file.vault_id),
        encode_component(&file.guid)
    )))
}

#[derive(Deserialize)]
pub struct PathPermalinkQuery {
    pub vault: String,
    pub path: String,
}

pub async fn note_by_path(Query(query): Query<PathPermalinkQuery>) -> Response {
    if query.vault.is_empty() || query.path.is_empty() {
        return (StatusCode::BAD_REQUEST, "invalid permalink").into_response();
    }
    // See note_by_guid: the obsidian deeplink must avoid the reserved `vault`
    // parameter, so emit `vaultId` even though the public `/p` query still
    // accepts `vault` for readability.
    Redirect::temporary(&format!(
        "obsidian://instasync-open?vaultId={}&path={}",
        encode_component(&query.vault),
        encode_component(&query.path)
    ))
    .into_response()
}

fn encode_component(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}
