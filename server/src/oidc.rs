use axum::extract::{Query, State};
use axum::response::{Html, IntoResponse, Redirect, Response};
use openidconnect::core::{CoreAuthenticationFlow, CoreClient, CoreProviderMetadata};
use openidconnect::{
    AuthorizationCode, ClientId, ClientSecret, CsrfToken, IssuerUrl, Nonce, PkceCodeChallenge,
    PkceCodeVerifier, RedirectUrl, Scope, TokenResponse,
};
use serde::Deserialize;

use crate::config::OidcMode;
use crate::error::{AppError, AppResult};
use crate::session::now_millis;
use crate::session::{create_session, upsert_user};
use crate::state::{AppState, MockIdentity, OidcFlow};

#[derive(Debug, Deserialize)]
pub struct LoginParams {
    /// Where to send the browser after login (e.g. `obsidian://instasync-auth`).
    pub redirect: Option<String>,
    // Mock-mode only: lets tests choose distinct identities.
    pub mock_sub: Option<String>,
    pub mock_email: Option<String>,
    pub mock_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CallbackParams {
    pub code: Option<String>,
    pub state: Option<String>,
}

/// Begin login. Stores the flow state and 302s to the IdP (or, in mock mode,
/// straight to our own callback).
pub async fn login(
    State(state): State<AppState>,
    Query(params): Query<LoginParams>,
) -> AppResult<Response> {
    let redirect = validate_login_redirect(&state, params.redirect.as_deref())?;
    prune_oidc_flows(&state).await;

    match state.config.oidc_mode {
        OidcMode::Mock => {
            let csrf = CsrfToken::new_random();
            let identity = MockIdentity {
                issuer: "mock".to_string(),
                subject: params.mock_sub.unwrap_or_else(|| "mock-user".to_string()),
                email: params
                    .mock_email
                    .unwrap_or_else(|| "mock@example.com".to_string()),
                name: params.mock_name.unwrap_or_else(|| "Mock User".to_string()),
            };
            state.oidc.lock().await.insert(
                csrf.secret().clone(),
                OidcFlow {
                    pkce_verifier: String::new(),
                    nonce: String::new(),
                    redirect,
                    created_at: now_millis(),
                    mock: Some(identity),
                },
            );
            let url = format!("/auth/callback?state={}", csrf.secret());
            Ok(Redirect::to(&url).into_response())
        }
        OidcMode::Oidc => {
            let (metadata, client_id, client_secret, redirect_uri) = discover(&state).await?;
            let client = CoreClient::from_provider_metadata(metadata, client_id, client_secret)
                .set_redirect_uri(redirect_uri);
            let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
            let (auth_url, csrf, nonce) = client
                .authorize_url(
                    CoreAuthenticationFlow::AuthorizationCode,
                    CsrfToken::new_random,
                    Nonce::new_random,
                )
                .add_scope(Scope::new("openid".to_string()))
                .add_scope(Scope::new("email".to_string()))
                .add_scope(Scope::new("profile".to_string()))
                .set_pkce_challenge(pkce_challenge)
                .url();
            state.oidc.lock().await.insert(
                csrf.secret().clone(),
                OidcFlow {
                    pkce_verifier: pkce_verifier.secret().clone(),
                    nonce: nonce.secret().clone(),
                    redirect,
                    created_at: now_millis(),
                    mock: None,
                },
            );
            Ok(Redirect::to(auth_url.as_str()).into_response())
        }
    }
}

/// Finish login: resolve the identity, upsert the user, mint a session, and
/// either 302 back to the stored redirect with `?token=` or render the token.
pub async fn callback(
    State(state): State<AppState>,
    Query(params): Query<CallbackParams>,
) -> AppResult<Response> {
    let csrf_state = params
        .state
        .clone()
        .ok_or_else(|| AppError::BadRequest("missing state".into()))?;
    let flow = state
        .oidc
        .lock()
        .await
        .remove(&csrf_state)
        .ok_or_else(|| AppError::BadRequest("unknown or expired state".into()))?;

    if flow.is_expired() {
        return Err(AppError::BadRequest("unknown or expired state".into()));
    }

    let (issuer, subject, email, name) = if let Some(mock) = flow.mock {
        (mock.issuer, mock.subject, mock.email, mock.name)
    } else {
        resolve_oidc_identity(&state, &flow, &params).await?
    };

    let user = upsert_user(&state.db, &issuer, &subject, &email, &name).await?;
    let token = create_session(&state.db, &user.id).await?;

    if flow.redirect.is_empty() {
        Ok(Html(token_page(&token)).into_response())
    } else {
        let sep = if flow.redirect.contains('?') {
            '&'
        } else {
            '?'
        };
        let dest = format!("{}{}token={}", flow.redirect, sep, token);
        let is_web = dest.starts_with("http://") || dest.starts_with("https://");
        if is_web {
            Ok(Redirect::to(&dest).into_response())
        } else {
            // We can't 303 straight to a custom scheme like `obsidian://…`:
            // browsers refuse to launch the protocol handler from a server
            // redirect without a user gesture, so the deep link would silently
            // never fire. Serve an interstitial that tries the link via JS,
            // offers a manual button (a real user gesture), and always keeps the
            // paste-code fallback visible.
            Ok(Html(redirect_page(&dest, &token)).into_response())
        }
    }
}

fn validate_login_redirect(state: &AppState, redirect: Option<&str>) -> AppResult<String> {
    let Some(redirect) = redirect else {
        return Ok(String::new());
    };
    if redirect.is_empty() || redirect == "obsidian://instasync-auth" {
        return Ok(redirect.to_string());
    }

    let url = url::Url::parse(redirect)
        .map_err(|_| AppError::BadRequest("invalid login redirect".into()))?;
    let origin = url.origin().ascii_serialization();
    let public_origin = url::Url::parse(&state.config.public_base_url)
        .ok()
        .map(|u| u.origin().ascii_serialization());
    let allowed = state.config.allowed_login_redirects.iter().any(|allowed| {
        url::Url::parse(allowed)
            .map(|u| u.origin().ascii_serialization() == origin)
            .unwrap_or(false)
    });
    if allowed || public_origin.as_deref() == Some(origin.as_str()) {
        Ok(redirect.to_string())
    } else {
        Err(AppError::BadRequest("login redirect is not allowed".into()))
    }
}

async fn prune_oidc_flows(state: &AppState) {
    let mut flows = state.oidc.lock().await;
    flows.retain(|_, flow| !flow.is_expired());
}

/// Exchange the authorization code and verify the id_token (real IdP path).
async fn resolve_oidc_identity(
    state: &AppState,
    flow: &OidcFlow,
    params: &CallbackParams,
) -> AppResult<(String, String, String, String)> {
    let code = params
        .code
        .clone()
        .ok_or_else(|| AppError::BadRequest("missing code".into()))?;

    let (metadata, client_id, client_secret, redirect_uri) = discover(state).await?;
    let client = CoreClient::from_provider_metadata(metadata, client_id, client_secret)
        .set_redirect_uri(redirect_uri);
    let token_response = client
        .exchange_code(AuthorizationCode::new(code))
        .map_err(|e| AppError::Internal(format!("exchange_code: {e}")))?
        .set_pkce_verifier(PkceCodeVerifier::new(flow.pkce_verifier.clone()))
        .request_async(&state.http)
        .await
        .map_err(|e| AppError::Internal(format!("token request: {e}")))?;

    let verifier = client.id_token_verifier();
    let nonce = Nonce::new(flow.nonce.clone());
    let id_token = token_response
        .id_token()
        .ok_or_else(|| AppError::Internal("no id_token in response".into()))?;
    let claims = id_token
        .claims(&verifier, &nonce)
        .map_err(|e| AppError::Internal(format!("id_token verify: {e}")))?;

    let issuer = claims.issuer().to_string();
    let subject = claims.subject().to_string();
    let email = claims
        .email()
        .map(|e| e.to_string())
        .unwrap_or_else(|| format!("{subject}@{issuer}"));
    let name = claims
        .name()
        .and_then(|n| n.get(None))
        .map(|n| n.to_string())
        .unwrap_or_else(|| email.clone());

    Ok((issuer, subject, email, name))
}

/// Run OIDC discovery and gather the pieces needed to build a client. The client
/// itself is constructed inline by callers so its endpoint type-state markers are
/// inferred (openidconnect v4 encodes "endpoint set" in the type).
async fn discover(
    state: &AppState,
) -> AppResult<(
    CoreProviderMetadata,
    ClientId,
    Option<ClientSecret>,
    RedirectUrl,
)> {
    let cfg = &state.config;
    let issuer = cfg
        .oidc_issuer
        .clone()
        .ok_or_else(|| AppError::Internal("OIDC_ISSUER not set".into()))?;
    let client_id = cfg
        .oidc_client_id
        .clone()
        .ok_or_else(|| AppError::Internal("OIDC_CLIENT_ID not set".into()))?;

    let issuer_url =
        IssuerUrl::new(issuer).map_err(|e| AppError::Internal(format!("issuer url: {e}")))?;
    let metadata = CoreProviderMetadata::discover_async(issuer_url, &state.http)
        .await
        .map_err(|e| AppError::Internal(format!("discovery: {e}")))?;
    let redirect = RedirectUrl::new(cfg.redirect_url())
        .map_err(|e| AppError::Internal(format!("redirect url: {e}")))?;

    Ok((
        metadata,
        ClientId::new(client_id),
        cfg.oidc_client_secret.clone().map(ClientSecret::new),
        redirect,
    ))
}

/// Interstitial shown after a successful login when a deep-link redirect target
/// was supplied. Fires the `obsidian://…` link from JS, exposes a manual button
/// (so the user gesture lets the browser launch the external handler), and keeps
/// the paste-code fallback visible in case the protocol handler isn't registered.
fn redirect_page(dest: &str, token: &str) -> String {
    let href = html_escape(dest);
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>InstaSync</title></head>\
<body style=\"font-family:system-ui;max-width:40rem;margin:3rem auto\">\
<h2>InstaSync sign-in complete</h2>\
<p><a id=\"open\" href=\"{href}\" \
style=\"display:inline-block;padding:.6rem 1rem;background:#7c3aed;color:#fff;\
border-radius:6px;text-decoration:none\">Open Obsidian</a> to finish signing in.</p>\
<p>If Obsidian did not open automatically, click the button above, or copy this \
code into the plugin's <em>paste code</em> field:</p>\
<pre style=\"padding:1rem;background:#f4f4f4;border-radius:6px;user-select:all\">{token}</pre>\
<script>setTimeout(function(){{try{{document.getElementById('open').click();}}catch(e){{}}}},100);</script>\
</body></html>"
    )
}

/// Minimal HTML-attribute escaping for values we interpolate into markup.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn token_page(token: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>InstaSync</title></head>\
<body style=\"font-family:system-ui;max-width:40rem;margin:3rem auto\">\
<h2>InstaSync sign-in complete</h2>\
<p>If Obsidian did not open automatically, copy this code into the plugin's \
<em>paste code</em> field:</p>\
<pre style=\"padding:1rem;background:#f4f4f4;border-radius:6px;user-select:all\">{token}</pre>\
</body></html>"
    )
}
