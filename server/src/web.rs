//! Serves the built read-only viewer SPA (`packages/web`, Vite build output)
//! at `/view/{share_id}`. The SPA reads the share id from the URL client-side,
//! so every share path serves the same `index.html`; hashed assets live under
//! `/view/assets/`. Dev workflow uses Vite's dev server (which proxies `/api`)
//! instead of these routes.

use std::path::{Path as FsPath, PathBuf};

use axum::extract::{Path, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub async fn serve_index(State(state): State<AppState>) -> AppResult<Response> {
    let path = PathBuf::from(&state.config.web_dist_path).join("index.html");
    let html = tokio::fs::read(&path).await.map_err(|_| {
        AppError::Internal(format!(
            "web viewer not built: missing {} (run `bun run build:web` or set WEB_DIST_PATH)",
            path.display()
        ))
    })?;
    Ok(([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response())
}

pub async fn serve_asset(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> AppResult<Response> {
    for component in path.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(AppError::BadRequest("invalid asset path".into()));
        }
    }
    let full = PathBuf::from(&state.config.web_dist_path)
        .join("assets")
        .join(&path);
    let bytes = tokio::fs::read(&full)
        .await
        .map_err(|_| AppError::NotFound)?;
    Ok((
        [
            (header::CONTENT_TYPE, content_type(&full)),
            // Vite asset filenames are content-hashed, so cache aggressively.
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        bytes,
    )
        .into_response())
}

fn content_type(path: &FsPath) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "js" => "text/javascript",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "map" | "json" => "application/json",
        _ => "application/octet-stream",
    }
}
