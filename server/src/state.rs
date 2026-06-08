use std::collections::HashMap;
use std::sync::Arc;

use sea_orm::DatabaseConnection;
use tokio::sync::Mutex;
use y_sweet_core::auth::Authenticator;

use crate::session::now_millis;

use crate::config::Config;
use crate::git::GitService;
use crate::search::SearchService;

/// The actor that initiated a write attributed to a real authenticated user.
#[derive(Clone, Debug)]
pub enum PrincipalActor {
    User,
    Cursor {
        cursor_id: String,
        app_id: String,
        cursor_name: String,
    },
}

/// An authenticated principal bound to a y-sweet connection token at mint time,
/// used to attribute git audit commits. Cursor writes retain the real user in
/// `user_id` / `display_name` / `email` and store the cursor as `actor`.
#[derive(Clone, Debug)]
pub struct Principal {
    pub user_id: String,
    pub display_name: String,
    pub email: String,
    pub actor: PrincipalActor,
    /// Epoch millis after which this token->principal mapping is evicted.
    pub expires_at_ms: i64,
}

impl Principal {
    pub fn actor_key(&self) -> String {
        match &self.actor {
            PrincipalActor::User => format!("user:{}", self.user_id),
            PrincipalActor::Cursor { cursor_id, .. } => format!("cursor:{cursor_id}"),
        }
    }
}

/// A synthetic identity used by the mock OIDC issuer (test mode).
#[derive(Clone)]
pub struct MockIdentity {
    pub issuer: String,
    pub subject: String,
    pub email: String,
    pub name: String,
}

/// Pending OIDC Authorization-Code flow, keyed by `state`.
pub struct OidcFlow {
    pub pkce_verifier: String,
    pub nonce: String,
    pub redirect: String,
    pub created_at: i64,
    /// Present only in mock mode; lets the callback skip the IdP round-trip.
    pub mock: Option<MockIdentity>,
    pub oauth_flow_key: Option<String>,
}

impl OidcFlow {
    pub fn is_expired(&self) -> bool {
        now_millis() - self.created_at > 5 * 60 * 1000
    }
}

pub struct OAuthFlow {
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub scope: String,
    pub state: Option<String>,
    pub app_id: String,
    pub created_at: i64,
}

impl OAuthFlow {
    pub fn is_expired(&self) -> bool {
        now_millis() - self.created_at > 5 * 60 * 1000
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db: DatabaseConnection,
    pub config: Arc<Config>,
    /// Stable, persisted id for this server, advertised via `/api/server-info`.
    pub server_id: String,
    pub authenticator: Arc<Authenticator>,
    pub http: reqwest::Client,
    pub oidc: Arc<Mutex<HashMap<String, OidcFlow>>>,
    pub oauth_flows: Arc<Mutex<HashMap<String, OAuthFlow>>>,
    /// Per-vault git audit log + backup engine.
    pub git: GitService,
    /// Per-vault debounced search indexer.
    pub search: SearchService,
    /// Maps a minted y-sweet connection token to the principal it was issued to,
    /// so the proxy can attribute document writes to an authenticated identity.
    pub principals: Arc<Mutex<HashMap<String, Principal>>>,
}

impl AppState {
    /// Remember which principal a freshly minted connection token belongs to.
    /// Lazily evicts expired entries.
    pub async fn record_principal(&self, token: String, principal: Principal) {
        let mut map = self.principals.lock().await;
        let now = now_millis();
        map.retain(|_, p| p.expires_at_ms > now);
        map.insert(token, principal);
    }

    /// Resolve a connection token to its (unexpired) principal, if known.
    pub async fn principal_for_token(&self, token: &str) -> Option<Principal> {
        let map = self.principals.lock().await;
        map.get(token)
            .filter(|p| p.expires_at_ms > now_millis())
            .cloned()
    }
}
