use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use sea_orm::{ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Set};
use sha2::{Digest, Sha256};

use crate::entities::{sessions, users};
use crate::error::AppError;
use crate::state::AppState;

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
