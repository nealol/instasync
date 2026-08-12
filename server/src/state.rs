use std::collections::HashMap;
use std::sync::Arc;

use sea_orm::DatabaseConnection;
use tokio::sync::Mutex;

use crate::session::now_millis;

use crate::config::Config;
use crate::crdt::{DocumentStore, Level};
use crate::git::GitService;
use crate::jobs::JobQueue;
use crate::operations::{RuntimeHealth, SyncMetrics};
use crate::plugindb::PluginDbService;
use crate::search::SearchService;

/// The actor that initiated a write attributed to a real authenticated user.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub enum PrincipalActor {
    User,
    Cursor {
        cursor_id: String,
        app_id: String,
        cursor_name: String,
    },
}

/// An authenticated principal bound to a document connection token at mint time,
/// used to attribute git audit commits. Cursor writes retain the real user in
/// `user_id` / `display_name` / `email` and store the cursor as `actor`.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub struct Principal {
    pub user_id: String,
    pub display_name: String,
    pub email: String,
    pub git_email: Option<String>,
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

#[derive(Clone, Debug)]
pub struct SyncGrant {
    pub document_id: String,
    pub level: Level,
    pub epoch: u64,
    pub principal: Principal,
}

/// A synthetic identity used by the mock OIDC issuer (test mode).
#[derive(Clone)]
pub struct MockIdentity {
    pub issuer: String,
    pub subject: String,
    pub email: String,
    pub name: String,
    pub picture: Option<String>,
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
    /// Native persistent Yjs document engine.
    pub documents: DocumentStore,
    /// Persistent Apalis queue for derived server work.
    pub jobs: JobQueue,
    pub http: reqwest::Client,
    pub oidc: Arc<Mutex<HashMap<String, OidcFlow>>>,
    pub oauth_flows: Arc<Mutex<HashMap<String, OAuthFlow>>>,
    /// Per-vault git audit log + backup engine.
    pub git: GitService,
    /// Synced plugin-database replication engine.
    pub plugindb: PluginDbService,
    /// Persistent search reconciliation scheduler.
    pub search: SearchService,
    /// Opaque, document-scoped sync tokens. Tokens are intentionally
    /// process-local; clients refresh them after a server restart.
    pub sync_grants: Arc<Mutex<HashMap<String, SyncGrant>>>,
    /// Process-local sync counters exported through `/metrics`.
    pub sync_metrics: SyncMetrics,
    /// Readiness state; set to draining before graceful HTTP shutdown.
    pub runtime_health: RuntimeHealth,
}

impl AppState {
    /// Remember the document, access level, and principal for a freshly minted
    /// connection token. Lazily evicts expired entries.
    pub async fn record_sync_grant(
        &self,
        token: String,
        document_id: String,
        level: Level,
        epoch: u64,
        principal: Principal,
    ) {
        let mut map = self.sync_grants.lock().await;
        let now = now_millis();
        map.retain(|_, grant| grant.principal.expires_at_ms > now);
        map.insert(
            token,
            SyncGrant {
                document_id,
                level,
                epoch,
                principal,
            },
        );
    }

    /// Resolve an unexpired token only for the document it was minted for.
    pub async fn sync_grant(&self, token: &str, document_id: &str) -> Option<SyncGrant> {
        let mut map = self.sync_grants.lock().await;
        let now = now_millis();
        map.retain(|_, grant| grant.principal.expires_at_ms > now);
        map.get(token)
            .filter(|grant| grant.document_id == document_id)
            .cloned()
    }
}
