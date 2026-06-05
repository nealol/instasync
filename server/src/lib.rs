pub mod config;
pub mod db;
pub mod entities;
pub mod error;
pub mod oidc;
pub mod proxy;
pub mod routes;
pub mod session;
pub mod state;
pub mod words;
pub mod ysweet;

use std::sync::Arc;

use axum::{
    routing::{any, get, post},
    Router,
};
use sea_orm::Database;
use tower_http::cors::{Any, CorsLayer};
use y_sweet_core::auth::Authenticator;

use crate::config::Config;
use crate::state::AppState;

/// Generate a fresh y-sweet-compatible private key (used by tests and `gen-key`).
pub fn gen_auth_key() -> String {
    Authenticator::gen_key()
        .expect("generate auth key")
        .private_key()
}

/// Build the full application state from config, opening the DB and creating the
/// schema if needed. Shared by the binary and the integration tests.
pub async fn build_state(config: Config) -> anyhow::Result<AppState> {
    let db = Database::connect(&config.database_url).await?;
    db::init_schema(&db).await?;

    let authenticator = Authenticator::new(&config.ysweet_auth_key)
        .map_err(|e| anyhow::anyhow!("invalid YSWEET_AUTH_KEY: {e}"))?;

    let http = reqwest::Client::builder()
        // Following redirects on the token endpoint opens us to SSRF.
        .redirect(reqwest::redirect::Policy::none())
        .build()?;

    Ok(AppState {
        db,
        config: Arc::new(config),
        authenticator: Arc::new(authenticator),
        http,
        oidc: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
    })
}

/// Assemble the axum router for the given state.
pub fn app(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/auth/login", get(oidc::login))
        .route("/auth/callback", get(oidc::callback))
        .route("/api/me", get(routes::me))
        .route("/api/vaults", get(routes::list_vaults).post(routes::create_vault))
        .route("/api/vaults/{id}/invites", post(routes::create_invite))
        .route("/api/vaults/{id}/members", get(routes::list_members))
        .route(
            "/api/vaults/{id}/members/{user_id}/promote",
            post(routes::promote_member),
        )
        .route("/api/vaults/{id}/files", post(routes::upsert_file))
        .route("/api/invites/redeem", post(routes::redeem_invite))
        .route("/api/doc-token", post(routes::doc_token))
        // Reverse-proxy the bundled y-sweet so clients need only this server's URL.
        .route("/d/{*rest}", any(proxy::proxy))
        .layer(cors)
        .with_state(state)
}
