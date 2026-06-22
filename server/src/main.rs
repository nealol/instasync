use realtime_server::{app, build_state, config::Config, SERVER_NAME};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let config = Config::from_env();
    let bind_addr = config.bind_addr.clone();

    if config.ysweet_auth_key.is_empty() {
        tracing::warn!(
            "YSWEET_AUTH_KEY is not set — y-sweet authentication will fail. \
             Set it to the same key passed to `y-sweet serve --auth`."
        );
    }
    if config.upload_token == "dev-upload-token-change-me" {
        tracing::warn!(
            "UPLOAD_TOKEN is using the insecure default. \
             Set UPLOAD_TOKEN to a strong secret in production."
        );
    }

    tracing::info!(
        "{} auth server: oidc_mode={:?}, ysweet={}",
        SERVER_NAME,
        config.oidc_mode,
        config.ysweet_url
    );

    let state = build_state(config).await?;
    let router = app(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!("listening on {bind_addr}");
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            tracing::warn!("failed to install Ctrl-C handler");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(e) => {
                tracing::warn!("failed to install SIGTERM handler: {e}");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
