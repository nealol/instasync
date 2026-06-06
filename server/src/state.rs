use std::collections::HashMap;
use std::sync::Arc;

use sea_orm::DatabaseConnection;
use tokio::sync::Mutex;
use y_sweet_core::auth::Authenticator;

use crate::session::now_millis;

use crate::config::Config;
use crate::git::GitService;

/// An authenticated principal (an OIDC user today; an API-key application in the
/// future) bound to a y-sweet connection token at mint time, used to attribute
/// git audit commits. See [`crate::git`] and the proxy attribution tap.
#[derive(Clone, Debug)]
pub struct Principal {
    pub user_id: String,
    pub display_name: String,
    pub email: String,
    /// Epoch millis after which this token->principal mapping is evicted.
    pub expires_at_ms: i64,
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
}

impl OidcFlow {
    pub fn is_expired(&self) -> bool {
        now_millis() - self.created_at > 5 * 60 * 1000
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db: DatabaseConnection,
    pub config: Arc<Config>,
    pub authenticator: Arc<Authenticator>,
    pub http: reqwest::Client,
    pub oidc: Arc<Mutex<HashMap<String, OidcFlow>>>,
    /// Per-vault git audit log + backup engine.
    pub git: GitService,
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
