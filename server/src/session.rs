use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use sea_orm::{ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Set};
use sha2::{Digest, Sha256};

use crate::entities::{oauth_tokens, remote_cursor_tokens, remote_cursors, sessions, users};
use crate::error::AppError;
use crate::state::{AppState, Principal, PrincipalActor};

/// Milliseconds since the Unix epoch.
pub fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const SESSION_TTL_MS: i64 = 1000 * 60 * 60 * 24 * 30; // 30 days

fn random_token() -> String {
    use rand::Rng;
    let bytes: [u8; 32] = rand::thread_rng().gen();
    // hex, url-safe
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Upsert a user by (issuer, subject); refreshes email / display name on login.
pub async fn upsert_user(
    db: &impl ConnectionTrait,
    issuer: &str,
    subject: &str,
    email: &str,
    display_name: &str,
) -> Result<users::Model, AppError> {
    let existing = users::Entity::find()
        .filter(users::Column::OidcIssuer.eq(issuer))
        .filter(users::Column::OidcSubject.eq(subject))
        .one(db)
        .await?;

    if let Some(model) = existing {
        let mut active: users::ActiveModel = model.into();
        active.email = Set(email.to_string());
        active.display_name = Set(display_name.to_string());
        Ok(active.update(db).await?)
    } else {
        let model = users::ActiveModel {
            id: Set(uuid::Uuid::new_v4().to_string()),
            oidc_issuer: Set(issuer.to_string()),
            oidc_subject: Set(subject.to_string()),
            email: Set(email.to_string()),
            display_name: Set(display_name.to_string()),
            created_at: Set(now_millis()),
        };
        Ok(model.insert(db).await?)
    }
}

/// Create a session row for the user and return its opaque bearer token.
pub async fn create_session(db: &impl ConnectionTrait, user_id: &str) -> Result<String, AppError> {
    let token = random_token();
    let token_hash = hash_token(&token);
    let now = now_millis();
    let model = sessions::ActiveModel {
        token: Set(token_hash),
        user_id: Set(user_id.to_string()),
        created_at: Set(now),
        expires_at: Set(now + SESSION_TTL_MS),
    };
    model.insert(db).await?;
    Ok(token)
}

pub(crate) fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

pub async fn revoke_session(db: &impl ConnectionTrait, token: &str) -> Result<(), AppError> {
    sessions::Entity::delete_by_id(hash_token(token))
        .exec(db)
        .await?;
    Ok(())
}

pub fn bearer_token(header: &str) -> Option<&str> {
    header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))
}

/// Authenticated user, extracted from the `Authorization: Bearer <token>` header.
pub struct AuthUser(pub users::Model);

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;
        let token = bearer_token(header).ok_or(AppError::Unauthorized)?;

        let session = sessions::Entity::find_by_id(hash_token(token))
            .one(&state.db)
            .await?
            .ok_or(AppError::Unauthorized)?;

        if session.expires_at < now_millis() {
            return Err(AppError::Unauthorized);
        }

        let user = users::Entity::find_by_id(session.user_id)
            .one(&state.db)
            .await?
            .ok_or(AppError::Unauthorized)?;

        Ok(AuthUser(user))
    }
}

/// Resolve a hashed bearer secret to a remote cursor, accepting both the
/// legacy single `remote_cursors.token_hash` and rows in
/// `remote_cursor_tokens` (plugin-managed cursors can hold several active
/// tokens). Expired token rows are deleted lazily when touched.
pub async fn cursor_by_token_hash(
    db: &impl ConnectionTrait,
    token_hash: &str,
) -> Result<Option<remote_cursors::Model>, AppError> {
    if let Some(cursor) = remote_cursors::Entity::find()
        .filter(remote_cursors::Column::TokenHash.eq(token_hash))
        .one(db)
        .await?
    {
        return Ok(Some(cursor));
    }
    let Some(row) = remote_cursor_tokens::Entity::find()
        .filter(remote_cursor_tokens::Column::TokenHash.eq(token_hash))
        .one(db)
        .await?
    else {
        return Ok(None);
    };
    if row.expires_at < now_millis() {
        remote_cursor_tokens::Entity::delete_by_id(row.id)
            .exec(db)
            .await?;
        return Ok(None);
    }
    Ok(remote_cursors::Entity::find_by_id(row.cursor_id)
        .one(db)
        .await?)
}

/// Build a cursor-actor principal by loading the cursor's authorizing user.
pub async fn cursor_principal(
    db: &impl ConnectionTrait,
    cursor: remote_cursors::Model,
) -> Result<ApiPrincipal, AppError> {
    let user = users::Entity::find_by_id(cursor.created_by.clone())
        .one(db)
        .await?
        .ok_or(AppError::Unauthorized)?;
    Ok(ApiPrincipal {
        user,
        actor: ApiActor::Cursor(cursor),
    })
}

#[derive(Clone, Debug)]
pub enum ApiActor {
    User,
    Cursor(remote_cursors::Model),
}

/// Bearer principal for new API/MCP surfaces. Accepts existing session tokens
/// and remote cursor secrets. Cursor principals are pinned to one vault.
#[derive(Clone, Debug)]
pub struct ApiPrincipal {
    pub user: users::Model,
    pub actor: ApiActor,
}

impl ApiPrincipal {
    pub fn pinned_vault_id(&self) -> Option<&str> {
        match &self.actor {
            ApiActor::User => None,
            ApiActor::Cursor(cursor) => Some(&cursor.vault_id),
        }
    }

    pub fn require_vault(&self, vault_id: &str) -> Result<(), AppError> {
        if self
            .pinned_vault_id()
            .is_some_and(|pinned| pinned != vault_id)
        {
            return Err(AppError::Forbidden);
        }
        Ok(())
    }

    pub fn to_git_principal(&self, expires_at_ms: i64) -> Principal {
        let actor = match &self.actor {
            ApiActor::User => PrincipalActor::User,
            ApiActor::Cursor(cursor) => PrincipalActor::Cursor {
                cursor_id: cursor.id.clone(),
                app_id: cursor.app_id.clone(),
                cursor_name: cursor.name.clone(),
            },
        };
        Principal {
            user_id: self.user.id.clone(),
            display_name: self.user.display_name.clone(),
            email: self.user.email.clone(),
            actor,
            expires_at_ms,
        }
    }
}

impl FromRequestParts<AppState> for ApiPrincipal {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;
        let token = bearer_token(header).ok_or(AppError::Unauthorized)?;
        let token_hash = hash_token(token);

        if let Some(session) = sessions::Entity::find_by_id(token_hash.clone())
            .one(&state.db)
            .await?
        {
            if session.expires_at < now_millis() {
                return Err(AppError::Unauthorized);
            }
            let user = users::Entity::find_by_id(session.user_id)
                .one(&state.db)
                .await?
                .ok_or(AppError::Unauthorized)?;
            return Ok(ApiPrincipal {
                user,
                actor: ApiActor::User,
            });
        }

        if let Some(cursor) = cursor_by_token_hash(&state.db, &token_hash).await? {
            return cursor_principal(&state.db, cursor).await;
        }

        let oauth = oauth_tokens::Entity::find_by_id(token_hash)
            .one(&state.db)
            .await?
            .ok_or(AppError::Unauthorized)?;
        if oauth.access_expires_at < now_millis() {
            return Err(AppError::Unauthorized);
        }
        let cursor = remote_cursors::Entity::find()
            .filter(remote_cursors::Column::AppId.eq(oauth.app_id))
            .one(&state.db)
            .await?
            .ok_or(AppError::Unauthorized)?;
        let user = users::Entity::find_by_id(cursor.created_by.clone())
            .one(&state.db)
            .await?
            .ok_or(AppError::Unauthorized)?;
        Ok(ApiPrincipal {
            user,
            actor: ApiActor::Cursor(cursor),
        })
    }
}
