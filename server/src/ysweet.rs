use serde_json::{json, Value};
use url::Url;

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
    Url::parse(url).ok().and_then(|u| u.host_str().map(|host| {
        if let Some(port) = u.port() {
            format!("{host}:{port}")
        } else {
            host.to_string()
        }
    }))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authority_strips_scheme_and_trailing_slash() {
        assert_eq!(authority("http://127.0.0.1:8080/").unwrap(), "127.0.0.1:8080");
        assert_eq!(authority("ws://example.com").unwrap(), "example.com");
    }

    #[test]
    fn rewrite_swaps_authority() {
        let mut v = json!({ "url": "ws://127.0.0.1:8080/d/abc", "baseUrl": "http://127.0.0.1:8080/d/abc" });
        rewrite_host(&mut v, "url", "127.0.0.1:8080", "sync.example.com");
        rewrite_host(&mut v, "baseUrl", "127.0.0.1:8080", "sync.example.com");
        assert_eq!(v["url"], "ws://sync.example.com/d/abc");
        assert_eq!(v["baseUrl"], "http://sync.example.com/d/abc");
    }
}
