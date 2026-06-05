use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set, TransactionTrait};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::entities::{invites, memberships, permissions, users, vault_files, vaults};
use crate::error::{AppError, AppResult};
use crate::session::{bearer_token, now_millis, revoke_session, AuthUser};
use crate::state::AppState;
use crate::words::generate_invite_code;
use crate::ysweet::{ensure_doc, mint_client_token, Level};

const ROLE_ADMIN: &str = "admin";
const ROLE_MEMBER: &str = "member";
const INVITE_TTL_MS: i64 = 1000 * 60 * 60 * 24 * 7;

// ---------- shared response shapes ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub user_id: String,
    pub email: String,
    pub display_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultResponse {
    pub id: String,
    pub name: String,
    pub role: String,
    pub created_by: String,
    pub owner: bool,
}

// ---------- membership guards ----------

async fn membership(
    state: &AppState,
    user_id: &str,
    vault_id: &str,
) -> AppResult<Option<memberships::Model>> {
    Ok(memberships::Entity::find()
        .filter(memberships::Column::UserId.eq(user_id))
        .filter(memberships::Column::VaultId.eq(vault_id))
        .one(&state.db)
        .await?)
}

pub(crate) async fn require_member(
    state: &AppState,
    user_id: &str,
    vault_id: &str,
) -> AppResult<memberships::Model> {
    membership(state, user_id, vault_id)
        .await?
        .ok_or(AppError::Forbidden)
}

async fn require_admin(
    state: &AppState,
    user_id: &str,
    vault_id: &str,
) -> AppResult<memberships::Model> {
    let m = require_member(state, user_id, vault_id).await?;
    if m.role != ROLE_ADMIN {
        return Err(AppError::Forbidden);
    }
    Ok(m)
}

// ---------- auth / session ----------

pub async fn me(AuthUser(user): AuthUser) -> Json<MeResponse> {
    Json(MeResponse {
        user_id: user.id,
        email: user.email,
        display_name: user.display_name,
    })
}

// ---------- vaults ----------

#[derive(Deserialize)]
pub struct CreateVaultBody {
    pub name: String,
}

pub async fn create_vault(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<CreateVaultBody>,
) -> AppResult<Json<VaultResponse>> {
    let now = now_millis();
    let vault_id = uuid::Uuid::new_v4().to_string();

    let txn = state.db.begin().await?;

    vaults::ActiveModel {
        id: Set(vault_id.clone()),
        name: Set(body.name.clone()),
        created_by: Set(user.id.clone()),
        created_at: Set(now),
    }
    .insert(&txn)
    .await?;

    memberships::ActiveModel {
        id: Set(uuid::Uuid::new_v4().to_string()),
        user_id: Set(user.id.clone()),
        vault_id: Set(vault_id.clone()),
        role: Set(ROLE_ADMIN.to_string()),
        created_at: Set(now),
    }
    .insert(&txn)
    .await?;

    txn.commit().await?;

    Ok(Json(VaultResponse {
        id: vault_id,
        name: body.name,
        role: ROLE_ADMIN.to_string(),
        created_by: user.id,
        owner: true,
    }))
}

pub async fn list_vaults(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> AppResult<Json<Vec<VaultResponse>>> {
    let mems = memberships::Entity::find()
        .filter(memberships::Column::UserId.eq(&user.id))
        .all(&state.db)
        .await?;

    let mut out = Vec::with_capacity(mems.len());
    for m in mems {
        if let Some(v) = vaults::Entity::find_by_id(m.vault_id.clone())
            .one(&state.db)
            .await?
        {
            out.push(VaultResponse {
                id: v.id,
                name: v.name,
                role: m.role,
                owner: v.created_by == user.id,
                created_by: v.created_by,
            });
        }
    }
    Ok(Json(out))
}

// ---------- invites ----------

#[derive(Deserialize)]
pub struct CreateInviteBody {
    pub role: Option<String>,
}

#[derive(Serialize)]
pub struct InviteResponse {
    pub code: String,
}

pub async fn create_invite(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(vault_id): Path<String>,
    Json(body): Json<CreateInviteBody>,
) -> AppResult<Json<InviteResponse>> {
    require_admin(&state, &user.id, &vault_id).await?;

    let role = match body.role.as_deref() {
        Some(ROLE_ADMIN) => ROLE_ADMIN,
        _ => ROLE_MEMBER,
    };

    // Retry on the (rare) code collision.
    for _ in 0..5 {
        let code = generate_invite_code();
        let res = invites::ActiveModel {
            id: Set(uuid::Uuid::new_v4().to_string()),
            vault_id: Set(vault_id.clone()),
            code: Set(code.clone()),
            role_granted: Set(role.to_string()),
            created_by: Set(user.id.clone()),
            used_by: Set(None),
            used_at: Set(None),
            created_at: Set(now_millis()),
            expires_at: Set(Some(now_millis() + INVITE_TTL_MS)),
        }
        .insert(&state.db)
        .await;

        match res {
            Ok(_) => return Ok(Json(InviteResponse { code })),
            Err(_) => continue, // unique violation -> new code
        }
    }
    Err(AppError::Internal("could not generate a unique invite".into()))
}

#[derive(Deserialize)]
pub struct RedeemBody {
    pub code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemResponse {
    pub vault_id: String,
    pub name: String,
}

pub async fn redeem_invite(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<RedeemBody>,
) -> AppResult<Json<RedeemResponse>> {
    let invite = invites::Entity::find()
        .filter(invites::Column::Code.eq(&body.code))
        .one(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;

    if invite.expires_at.is_some_and(|expires| expires < now_millis()) {
        return Err(AppError::NotFound);
    }

    let vault = vaults::Entity::find_by_id(invite.vault_id.clone())
        .one(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;

    // Already a member: idempotent success without consuming the invite.
    if membership(&state, &user.id, &invite.vault_id).await?.is_some() {
        return Ok(Json(RedeemResponse {
            vault_id: vault.id,
            name: vault.name,
        }));
    }

    let txn = state.db.begin().await?;

    // Atomic single-use claim: only succeeds while used_by IS NULL and unexpired.
    let claimed = invites::Entity::update_many()
        .col_expr(invites::Column::UsedBy, sea_orm::sea_query::Expr::value(user.id.clone()))
        .col_expr(invites::Column::UsedAt, sea_orm::sea_query::Expr::value(now_millis()))
        .filter(invites::Column::Code.eq(&body.code))
        .filter(invites::Column::UsedBy.is_null())
        .filter(invites::Column::ExpiresAt.is_null().or(invites::Column::ExpiresAt.gt(now_millis())))
        .exec(&txn)
        .await?;

    if claimed.rows_affected == 0 {
        return Err(AppError::Conflict("invite already used or expired".into()));
    }

    memberships::ActiveModel {
        id: Set(uuid::Uuid::new_v4().to_string()),
        user_id: Set(user.id.clone()),
        vault_id: Set(invite.vault_id.clone()),
        role: Set(invite.role_granted.clone()),
        created_at: Set(now_millis()),
    }
    .insert(&txn)
    .await?;

    txn.commit().await?;

    Ok(Json(RedeemResponse {
        vault_id: vault.id,
        name: vault.name,
    }))
}

// ---------- members ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberResponse {
    pub user_id: String,
    pub email: String,
    pub display_name: String,
    pub role: String,
    pub owner: bool,
}

pub async fn list_members(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(vault_id): Path<String>,
) -> AppResult<Json<Vec<MemberResponse>>> {
    require_member(&state, &user.id, &vault_id).await?;

    let vault = vaults::Entity::find_by_id(vault_id.clone())
        .one(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;

    let mems = memberships::Entity::find()
        .filter(memberships::Column::VaultId.eq(&vault_id))
        .all(&state.db)
        .await?;

    let mut out = Vec::with_capacity(mems.len());
    for m in mems {
        if let Some(u) = users::Entity::find_by_id(m.user_id.clone())
            .one(&state.db)
            .await?
        {
            let owner = u.id == vault.created_by;
            out.push(MemberResponse {
                user_id: u.id,
                email: u.email,
                display_name: u.display_name,
                role: m.role,
                owner,
            });
        }
    }
    Ok(Json(out))
}

pub async fn promote_member(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((vault_id, target_user_id)): Path<(String, String)>,
) -> AppResult<Json<MemberResponse>> {
    require_admin(&state, &user.id, &vault_id).await?;

    let m = require_member(&state, &target_user_id, &vault_id).await?;
    let mut active: memberships::ActiveModel = m.into();
    active.role = Set(ROLE_ADMIN.to_string());
    let updated = active.update(&state.db).await?;

    let u = users::Entity::find_by_id(target_user_id)
        .one(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;

    Ok(Json(MemberResponse {
        user_id: u.id,
        email: u.email,
        display_name: u.display_name,
        role: updated.role,
        owner: false,
    }))
}

pub async fn remove_member(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((vault_id, target_user_id)): Path<(String, String)>,
) -> AppResult<Json<Value>> {
    let actor = require_admin(&state, &user.id, &vault_id).await?;
    let target = require_member(&state, &target_user_id, &vault_id).await?;
    let vault = vaults::Entity::find_by_id(vault_id.clone())
        .one(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;

    if target_user_id == vault.created_by {
        return Err(AppError::Forbidden);
    }

    let actor_is_owner = user.id == vault.created_by;
    if target.role == ROLE_ADMIN && !actor_is_owner {
        return Err(AppError::Forbidden);
    }

    if target.role == ROLE_MEMBER && actor.role != ROLE_ADMIN {
        return Err(AppError::Forbidden);
    }

    memberships::Entity::delete_by_id(target.id)
        .exec(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---------- file registry ----------

#[derive(Deserialize)]
pub struct UpsertFileBody {
    pub guid: String,
    pub path: String,
}

pub async fn upsert_file(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(vault_id): Path<String>,
    Json(body): Json<UpsertFileBody>,
) -> AppResult<Json<Value>> {
    require_member(&state, &user.id, &vault_id).await?;

    let existing = vault_files::Entity::find()
        .filter(vault_files::Column::VaultId.eq(&vault_id))
        .filter(vault_files::Column::Guid.eq(&body.guid))
        .one(&state.db)
        .await?;

    if let Some(model) = existing {
        let mut active: vault_files::ActiveModel = model.into();
        active.path = Set(body.path.clone());
        active.updated_at = Set(now_millis());
        active.update(&state.db).await?;
    } else {
        vault_files::ActiveModel {
            id: Set(uuid::Uuid::new_v4().to_string()),
            vault_id: Set(vault_id.clone()),
            guid: Set(body.guid.clone()),
            path: Set(body.path.clone()),
            updated_at: Set(now_millis()),
        }
        .insert(&state.db)
        .await?;
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---------- doc-token minting ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTokenBody {
    pub vault_id: String,
    pub doc_id: String,
}

pub async fn doc_token(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<DocTokenBody>,
) -> AppResult<Json<Value>> {
    require_member(&state, &user.id, &body.vault_id).await?;

    if !safe_doc_id(&body.doc_id) {
        return Err(AppError::BadRequest("invalid doc id".into()));
    }

    // Cheap scope gate: the doc must belong to this vault's namespace.
    let prefix = format!("{}__", body.vault_id);
    if body.doc_id != body.vault_id && !body.doc_id.starts_with(&prefix) {
        return Err(AppError::Forbidden);
    }

    let level = authorize_doc(&state, &user, &body.vault_id, &body.doc_id).await?;

    ensure_doc(&state, &body.doc_id).await?;
    let token = mint_client_token(&state, &body.doc_id, level).await?;
    Ok(Json(token))
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Json<Value>> {
    let header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)?;
    let token = bearer_token(header).ok_or(AppError::Unauthorized)?;
    revoke_session(&state.db, token).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn safe_doc_id(doc_id: &str) -> bool {
    !doc_id.is_empty()
        && doc_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// Resolve the docId to a path and evaluate the (currently allow-all) ACL.
async fn authorize_doc(
    state: &AppState,
    user: &users::Model,
    vault_id: &str,
    doc_id: &str,
) -> AppResult<Level> {
    // Index doc (== vaultId) and unknown guids are treated as vault-level ("").
    let path = if doc_id == vault_id {
        String::new()
    } else {
        let guid = doc_id
            .strip_prefix(&format!("{vault_id}__"))
            .unwrap_or_default();
        vault_files::Entity::find()
            .filter(vault_files::Column::VaultId.eq(vault_id))
            .filter(vault_files::Column::Guid.eq(guid))
            .one(&state.db)
            .await?
            .map(|f| f.path)
            .unwrap_or_default()
    };

    let rows = permissions::Entity::find()
        .filter(permissions::Column::VaultId.eq(vault_id))
        .all(&state.db)
        .await?;

    // Most specific match wins: longer prefix first, user-specific over everyone.
    let mut best: Option<(i64, String)> = None;
    for r in rows {
        let principal_ok = match &r.principal_user_id {
            None => true,
            Some(uid) => uid == &user.id,
        };
        if !principal_ok || !path.starts_with(&r.path_prefix) {
            continue;
        }
        let specificity =
            r.path_prefix.len() as i64 * 2 + if r.principal_user_id.is_some() { 1 } else { 0 };
        if best.as_ref().map(|(s, _)| specificity > *s).unwrap_or(true) {
            best = Some((specificity, r.level));
        }
    }

    match best.map(|(_, level)| level).as_deref() {
        None | Some("full") => Ok(Level::Full),
        Some("read-only") => Ok(Level::ReadOnly),
        Some("deny") => Err(AppError::Forbidden),
        Some(other) => Err(AppError::Internal(format!("bad permission level {other}"))),
    }
}
