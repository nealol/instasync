pub mod attachments;
pub mod blobs;
pub mod config;
pub mod db;
pub mod entities;
pub mod error;
pub mod git;
pub mod mcp;
pub mod notes;
pub mod oauth;
pub mod oidc;
pub mod openapi;
pub mod permalink;
pub mod proxy;
pub mod routes;
pub mod search;
pub mod session;
pub mod state;
pub mod structured;
pub mod words;
pub mod ydoc;
pub mod ysweet;

pub const SERVER_NAME: &str = "Realtime";
pub const SERVER_SLUG: &str = "realtime";
pub const SERVER_BOT_EMAIL: &str = "realtime@localhost";

use std::sync::Arc;

use axum::{
    extract::DefaultBodyLimit,
    http::HeaderValue,
    routing::{any, delete, get, post, put},
    Router,
};
use sea_orm::Database;
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;
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
    let server_id = db::ensure_server_id(&db).await?;

    let authenticator = Arc::new(
        Authenticator::new(&config.ysweet_auth_key)
            .map_err(|e| anyhow::anyhow!("invalid YSWEET_AUTH_KEY: {e}"))?,
    );

    let http = reqwest::Client::builder()
        // Following redirects on the token endpoint opens us to SSRF.
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()?;

    let config = Arc::new(config);
    let git = git::GitService::new(
        config.clone(),
        http.clone(),
        db.clone(),
        authenticator.clone(),
    );
    let search = search::SearchService::new(config.clone());

    let state = AppState {
        db,
        config,
        server_id,
        authenticator,
        http,
        oidc: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        oauth_flows: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        git,
        search,
        principals: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
    };
    search::spawn_startup_backfill(state.clone());
    Ok(state)
}

/// Assemble the axum router for the given state.
pub fn app(state: AppState) -> Router {
    let cors = if state.config.cors_allowed_origins.is_empty() {
        CorsLayer::new()
            .allow_origin(HeaderValue::from_static("obsidian://app"))
            .allow_methods(Any)
            .allow_headers(Any)
    } else {
        let origins: Vec<HeaderValue> = state
            .config
            .cors_allowed_origins
            .iter()
            .filter_map(|origin| origin.parse().ok())
            .collect();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods(Any)
            .allow_headers(Any)
    };

    Router::new()
        .merge(SwaggerUi::new("/docs").url("/openapi.json", openapi::ApiDoc::openapi()))
        .merge(mcp::router(state.clone()))
        .route("/auth/login", get(oidc::login))
        .route("/auth/callback", get(oidc::callback))
        .route(
            "/.well-known/oauth-protected-resource",
            get(oauth::protected_resource),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp/i/{app_id}",
            get(oauth::protected_resource_app),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(oauth::authorization_server),
        )
        .route("/oauth/register", post(oauth::register_client))
        .route("/oauth/authorize", get(oauth::authorize))
        .route("/oauth/token", post(oauth::token))
        .route(
            "/upload",
            post(attachments::public_upload)
                .layer(DefaultBodyLimit::max(blobs::MAX_BLOB_BYTES as usize)),
        )
        .route("/n/{guid}", get(permalink::note_by_guid))
        .route("/p", get(permalink::note_by_path))
        .route("/api/server-info", get(routes::server_info))
        .route("/api/me", get(routes::me))
        .route("/api/logout", post(routes::logout))
        .route(
            "/api/vaults",
            get(routes::list_vaults).post(routes::create_vault),
        )
        .route("/api/vaults/{id}/invites", post(routes::create_invite))
        .route(
            "/api/vaults/{id}/cursors",
            get(routes::list_cursors).post(routes::create_cursor),
        )
        .route(
            "/api/vaults/{id}/cursors/{cursor_id}",
            post(routes::rename_cursor).delete(routes::delete_cursor),
        )
        .route(
            "/api/vaults/{id}/cursors/{cursor_id}/token",
            post(routes::regenerate_cursor_token),
        )
        .route("/api/vaults/{id}/members", get(routes::list_members))
        .route(
            "/api/vaults/{id}/members/{user_id}/promote",
            post(routes::promote_member),
        )
        .route(
            "/api/vaults/{id}/members/{user_id}",
            delete(routes::remove_member),
        )
        .route("/api/vaults/{id}/files", post(routes::upsert_file))
        .route(
            "/api/vaults/{id}/notes",
            get(notes::list_notes).post(notes::create_note),
        )
        .route("/api/vaults/{id}/search", get(search::search_notes))
        .route(
            "/api/vaults/{id}/canvases",
            get(structured::list_canvases).post(structured::create_canvas),
        )
        .route(
            "/api/vaults/{id}/bases",
            get(structured::list_bases).post(structured::create_base),
        )
        .route("/api/vaults/{id}/tags", get(search::list_tags))
        .route("/api/vaults/{id}/reindex", post(search::reindex))
        .route(
            "/api/vaults/{id}/backlinks/{*path}",
            get(search::list_backlinks),
        )
        .route(
            "/api/vaults/{id}/notes/{*path}",
            get(notes::read_note)
                .put(notes::replace_note)
                .patch(notes::patch_note)
                .delete(notes::delete_note),
        )
        .route(
            "/api/vaults/{id}/note-moves/{*path}",
            post(notes::move_note),
        )
        .route(
            "/api/vaults/{id}/note-permalinks/{*path}",
            post(notes::note_permalink),
        )
        .route(
            "/api/vaults/{id}/note-frontmatter/{*path}",
            get(notes::parse_frontmatter).patch(notes::patch_frontmatter),
        )
        .route(
            "/api/vaults/{id}/canvas/{*path}",
            get(structured::read_canvas)
                .put(structured::replace_canvas)
                .delete(structured::delete_canvas),
        )
        .route(
            "/api/vaults/{id}/canvas-nodes/{*path}",
            post(structured::add_canvas_node)
                .patch(structured::update_canvas_node)
                .delete(structured::delete_canvas_node),
        )
        .route(
            "/api/vaults/{id}/canvas-edges/{*path}",
            post(structured::add_canvas_edge)
                .patch(structured::update_canvas_edge)
                .delete(structured::delete_canvas_edge),
        )
        .route(
            "/api/vaults/{id}/canvas-moves/{*path}",
            post(structured::move_canvas),
        )
        .route(
            "/api/vaults/{id}/base/{*path}",
            get(structured::read_base)
                .put(structured::replace_base)
                .delete(structured::delete_base),
        )
        .route(
            "/api/vaults/{id}/base-views/{*path}",
            get(structured::list_base_views)
                .post(structured::add_base_view)
                .patch(structured::update_base_view)
                .delete(structured::delete_base_view),
        )
        .route(
            "/api/vaults/{id}/base-filters/{*path}",
            put(structured::set_base_filters),
        )
        .route(
            "/api/vaults/{id}/base-view-filters/{*path}",
            put(structured::set_base_view_filters),
        )
        .route(
            "/api/vaults/{id}/base-formulas/{*path}",
            put(structured::set_base_formula).delete(structured::delete_base_formula),
        )
        .route(
            "/api/vaults/{id}/base-properties/{*path}",
            put(structured::set_base_property).delete(structured::delete_base_property),
        )
        .route(
            "/api/vaults/{id}/base-moves/{*path}",
            post(structured::move_base),
        )
        .route(
            "/api/vaults/{id}/periodic/{period}",
            post(notes::periodic_note_get_or_create),
        )
        .route(
            "/api/vaults/{id}/periodic/{period}/append",
            post(notes::periodic_note_append),
        )
        .route(
            "/api/vaults/{id}/attachments",
            get(attachments::list_attachments),
        )
        .route(
            "/api/vaults/{id}/attachments/from-url",
            post(attachments::upload_attachment_url),
        )
        .route(
            "/api/vaults/{id}/attachments/upload-link",
            post(attachments::create_upload_link),
        )
        .route(
            "/api/vaults/{id}/attachments/{*path}",
            get(attachments::read_attachment)
                .head(attachments::head_attachment)
                .put(attachments::upload_attachment)
                .delete(attachments::delete_attachment)
                .layer(DefaultBodyLimit::max(blobs::MAX_BLOB_BYTES as usize)),
        )
        .route(
            "/api/vaults/{id}/attachment-moves/{*path}",
            post(attachments::move_attachment),
        )
        // Content-addressed binary blob store. PUT opts out of the default body
        // cap so large attachments can stream through (it verifies the hash).
        .route(
            "/api/vaults/{id}/blobs/{hash}",
            get(blobs::get_blob)
                .head(blobs::head_blob)
                .put(blobs::put_blob)
                .layer(DefaultBodyLimit::max(blobs::MAX_BLOB_BYTES as usize)),
        )
        .route("/api/invites/redeem", post(routes::redeem_invite))
        .route("/api/doc-token", post(routes::doc_token))
        // Reverse-proxy the bundled y-sweet so clients need only this server's URL.
        .route("/d/{*rest}", any(proxy::proxy))
        .layer(cors)
        .with_state(state)
}
