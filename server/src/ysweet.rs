use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::{OnceLock, Weak};
use tokio::sync::{Mutex, OwnedMutexGuard};
use url::Url;
use y_sweet_core::auth::Authenticator;

use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

static DOC_LOAD_LOCKS: OnceLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> = OnceLock::new();

/// Serialize requests that can cold-load the same y-sweet document.
///
/// y-sweet 0.9.1 checks its live map before an awaited load without locking by
/// doc id. Two cold requests can therefore load independent snapshots and the
/// later insert replaces an already-updated document. Every production path to
/// the bundled y-sweet process goes through this server, so holding this guard
/// through the upstream HTTP response or WebSocket handshake closes that race.
pub(crate) async fn lock_doc_load(doc_id: &str) -> OwnedMutexGuard<()> {
    let locks = DOC_LOAD_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let lock = {
        let mut locks = locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        match locks.get(doc_id).and_then(Weak::upgrade) {
            Some(lock) => lock,
            None => {
                let lock = Arc::new(Mutex::new(()));
                locks.insert(doc_id.to_string(), Arc::downgrade(&lock));
                lock
            }
        }
    };
    lock.lock_owned().await
}

/// Extract the document id from a y-sweet `/d/{docId}/...` path.
pub(crate) fn doc_id_from_path(path: &str) -> Option<&str> {
    let doc_id = path.strip_prefix("/d/")?.split('/').next()?;
    (!doc_id.is_empty()).then_some(doc_id)
}

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

/// Rewrite an advertised URL to a target origin while preserving its path,
/// query, and fragment.
fn rewrite_origin(value: &mut Value, key: &str, target: &str) -> Result<(), String> {
    let Some(advertised) = value.get(key).and_then(Value::as_str) else {
        return Ok(());
    };
    let mut url = Url::parse(advertised).map_err(|e| format!("invalid {key}: {e}"))?;
    let target = Url::parse(target).map_err(|e| format!("invalid target URL: {e}"))?;
    url.set_scheme(target.scheme())
        .map_err(|_| format!("invalid target URL scheme: {}", target.scheme()))?;
    url.set_host(target.host_str())
        .map_err(|e| format!("invalid target URL host: {e}"))?;
    url.set_port(target.port())
        .map_err(|_| format!("invalid target URL port: {:?}", target.port()))?;
    value[key] = Value::String(url.to_string());
    Ok(())
}

/// Ensure the doc exists on y-sweet (idempotent), authenticating with the server token.
pub async fn ensure_doc(state: &AppState, doc_id: &str) -> AppResult<()> {
    let _load_guard = lock_doc_load(doc_id).await;
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
    // y-sweet advertises its configured `--url-prefix` in `baseUrl`. Internal
    // calls must replace that entire origin with YSWEET_URL. Replacing only a
    // configured public host is insufficient: the bundled deployment does not
    // set YSWEET_PUBLIC_URL, and preserving an HTTPS scheme for loopback would
    // also fail. A public `/d` loopback deadlocks with the per-document load
    // lock because the proxy tries to acquire the guard already held here.
    rewrite_origin(&mut token, "baseUrl", &config.ysweet_url)
        .map_err(|e| AppError::Internal(format!("y-sweet auth baseUrl: {e}")))?;
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

    #[test]
    fn rewrite_origin_internalizes_public_https_url() {
        let mut value = json!({
            "baseUrl": "https://realtime.example/d/vault__guid?token=ignored"
        });
        rewrite_origin(&mut value, "baseUrl", "http://127.0.0.1:8080").unwrap();
        assert_eq!(
            value["baseUrl"],
            "http://127.0.0.1:8080/d/vault__guid?token=ignored"
        );
    }
}
