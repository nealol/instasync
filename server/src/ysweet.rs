use serde_json::{json, Value};
use std::sync::Arc;
use url::Url;
use y_sweet_core::auth::Authenticator;

use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// "full" | "read-only", matching y-sweet's `Authorization` serde encoding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Full,
    ReadOnly,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Full => "full",
            Level::ReadOnly => "read-only",
        }
    }
}

/// Strip the scheme from a base URL, returning the `host[:port]` authority.
fn authority(url: &str) -> Option<String> {
    Url::parse(url).ok().and_then(|u| {
        u.host_str().map(|host| {
            if let Some(port) = u.port() {
                format!("{host}:{port}")
            } else {
                host.to_string()
            }
        })
    })
}

/// Rewrite the internal y-sweet authority in a minted token URL to the public one.
fn rewrite_host(value: &mut Value, key: &str, internal: &str, public: &str) {
    if internal == public {
        return;
    }
    if let Some(s) = value.get(key).and_then(Value::as_str) {
        let replaced = s.replace(internal, public);
        value[key] = Value::String(replaced);
    }
}

/// Ensure the doc exists on y-sweet (idempotent), authenticating with the server token.
pub async fn ensure_doc(state: &AppState, doc_id: &str) -> AppResult<()> {
    let url = format!("{}/doc/new", state.config.ysweet_url.trim_end_matches('/'));
    let res = state
        .http
        .post(&url)
        .bearer_auth(state.authenticator.server_token())
        .json(&json!({ "docId": doc_id }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("y-sweet /doc/new: {e}")))?;
    // 200 = created/exists. Some versions 409 on an existing doc; treat as fine.
    if !res.status().is_success() && res.status().as_u16() != 409 {
        return Err(AppError::Internal(format!(
            "y-sweet /doc/new returned {}",
            res.status()
        )));
    }
    Ok(())
}

/// Relay `/doc/{id}/auth` and return the resulting ClientToken JSON with its
/// host rewritten from the internal y-sweet URL to the public one.
pub async fn mint_client_token(state: &AppState, doc_id: &str, level: Level) -> AppResult<Value> {
    let url = format!(
        "{}/doc/{}/auth",
        state.config.ysweet_url.trim_end_matches('/'),
        doc_id
    );
    let res = state
        .http
        .post(&url)
        .bearer_auth(state.authenticator.server_token())
        .json(&json!({ "authorization": level.as_str() }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("y-sweet auth: {e}")))?;

    if !res.status().is_success() {
        return Err(AppError::Internal(format!(
            "y-sweet auth returned {}",
            res.status()
        )));
    }

    let mut token: Value = res
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("y-sweet auth body: {e}")))?;

    let internal = authority(&state.config.ysweet_url)
        .ok_or_else(|| AppError::Internal("invalid YSWEET_URL".into()))?;
    let public = authority(&state.config.ysweet_public_url)
        .ok_or_else(|| AppError::Internal("invalid YSWEET_PUBLIC_URL".into()))?;
    rewrite_host(&mut token, "url", &internal, &public);
    rewrite_host(&mut token, "baseUrl", &internal, &public);
    Ok(token)
}

/// Mint a y-sweet ClientToken for server-to-y-sweet calls. Unlike
/// `mint_client_token`, this deliberately preserves y-sweet's internal base URL.
pub async fn mint_internal_token(
    state: &AppState,
    doc_id: &str,
    level: Level,
) -> AppResult<(String, String)> {
    mint_internal_token_with(
        &state.config,
        &state.http,
        &state.authenticator,
        doc_id,
        level,
    )
    .await
}

pub async fn mint_internal_token_with(
    config: &Arc<Config>,
    http: &reqwest::Client,
    authenticator: &Arc<Authenticator>,
    doc_id: &str,
    level: Level,
) -> AppResult<(String, String)> {
    let url = format!(
        "{}/doc/{}/auth",
        config.ysweet_url.trim_end_matches('/'),
        doc_id
    );
    let res = http
        .post(&url)
        .bearer_auth(authenticator.server_token())
        .json(&json!({ "authorization": level.as_str() }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("y-sweet auth: {e}")))?;

    if !res.status().is_success() {
        return Err(AppError::Internal(format!(
            "y-sweet auth returned {}",
            res.status()
        )));
    }

    let mut token: Value = res
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("y-sweet auth body: {e}")))?;
    // y-sweet advertises its configured `--public` URL as `baseUrl`, which in
    // deployments fronted by this auth server is the *public* HTTPS URL
    // (`https://host/d/{docId}`). Server-to-y-sweet calls must not loop back
    // out through the public reverse proxy — that turns a transient proxy
    // hiccup into a hard failure of git audit, search reindex, and public
    // share rendering. Rewrite the public authority back to the internal one
    // (the inverse of `mint_client_token`) so these calls hit y-sweet
    // directly over the internal network.
    let internal = authority(&config.ysweet_url)
        .ok_or_else(|| AppError::Internal("invalid YSWEET_URL".into()))?;
    let public = authority(&config.ysweet_public_url)
        .ok_or_else(|| AppError::Internal("invalid YSWEET_PUBLIC_URL".into()))?;
    rewrite_host(&mut token, "baseUrl", &public, &internal);
    let base_url = token
        .get("baseUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("y-sweet auth missing baseUrl".into()))?
        .to_string();
    let token = token
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("y-sweet auth missing token".into()))?
        .to_string();
    Ok((base_url, token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authority_strips_scheme_and_trailing_slash() {
        assert_eq!(
            authority("http://127.0.0.1:8080/").unwrap(),
            "127.0.0.1:8080"
        );
        assert_eq!(authority("ws://example.com").unwrap(), "example.com");
    }

    #[test]
    fn rewrite_swaps_authority() {
        let mut v =
            json!({ "url": "ws://127.0.0.1:8080/d/abc", "baseUrl": "http://127.0.0.1:8080/d/abc" });
        rewrite_host(&mut v, "url", "127.0.0.1:8080", "sync.example.com");
        rewrite_host(&mut v, "baseUrl", "127.0.0.1:8080", "sync.example.com");
        assert_eq!(v["url"], "ws://sync.example.com/d/abc");
        assert_eq!(v["baseUrl"], "http://sync.example.com/d/abc");
    }
}
