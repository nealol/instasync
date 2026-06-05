use std::collections::HashMap;
use std::sync::Arc;

use sea_orm::DatabaseConnection;
use tokio::sync::Mutex;
use y_sweet_core::auth::Authenticator;

use crate::config::Config;

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
    /// Present only in mock mode; lets the callback skip the IdP round-trip.
    pub mock: Option<MockIdentity>,
}

#[derive(Clone)]
pub struct AppState {
    pub db: DatabaseConnection,
    pub config: Arc<Config>,
    pub authenticator: Arc<Authenticator>,
    pub http: reqwest::Client,
    pub oidc: Arc<Mutex<HashMap<String, OidcFlow>>>,
}
