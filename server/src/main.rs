use instasync_server::{app, build_state, config::Config};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let config = Config::from_env();
    let bind_addr = config.bind_addr.clone();
    tracing::info!(
        "InstaSync auth server: oidc_mode={:?}, ysweet={}",
        config.oidc_mode,
        config.ysweet_url
    );

    let state = build_state(config).await?;
    let router = app(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!("listening on {bind_addr}");
    axum::serve(listener, router).await?;
    Ok(())
}
