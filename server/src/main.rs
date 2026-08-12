use std::future::IntoFuture;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use realtime_server::{
    app, build_state,
    config::Config,
    crdt_storage::{import_ysweet_store, inspect_store},
    full_backup::{self, InstanceLock},
    SERVER_NAME,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("crdt") => return run_crdt_command(args[1..].to_vec()).await,
        Some("backup") => return run_backup_command(args[1..].to_vec()).await,
        Some("compatibility") if args.len() == 1 => {
            let caps = realtime_server::caps::caps()
                .into_iter()
                .collect::<std::collections::BTreeMap<_, _>>();
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "version": env!("CARGO_PKG_VERSION"),
                    "caps": caps,
                    "requiredCaps": realtime_server::caps::REQUIRED,
                }))?
            );
            return Ok(());
        }
        Some(command) => anyhow::bail!("unknown command {command:?}"),
        None => {}
    }

    let config = Config::from_env();
    let _instance_lock = InstanceLock::acquire(&config)?;
    full_backup::ensure_restore_complete(&config)?;
    let bind_addr = config.bind_addr.clone();
    let server_shutdown_timeout_ms = config.server_shutdown_timeout_ms;
    let server_shutdown_timeout = Duration::from_millis(server_shutdown_timeout_ms);

    if config.upload_token == "dev-upload-token-change-me" {
        tracing::warn!(
            "UPLOAD_TOKEN is using the insecure default. \
             Set UPLOAD_TOKEN to a strong secret in production."
        );
    }

    tracing::info!(
        "{} server: oidc_mode={:?}, crdt_store={}",
        SERVER_NAME,
        config.oidc_mode,
        config.crdt_store_dir
    );

    let state = build_state(config).await?;
    let jobs = state.jobs.clone();
    let runtime_health = state.runtime_health.clone();
    let router = app(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!("listening on {bind_addr}");
    let shutdown_started = Arc::new(tokio::sync::Notify::new());
    let shutdown_observer = shutdown_started.clone();
    let shutdown = async move {
        shutdown_signal().await;
        runtime_health.begin_draining();
        shutdown_observer.notify_one();
        tracing::info!("shutdown requested; draining active connections");
    };
    let server = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .into_future();
    tokio::pin!(server);
    let result = tokio::select! {
        result = &mut server => result,
        _ = shutdown_started.notified() => {
            match tokio::time::timeout(server_shutdown_timeout, &mut server).await {
                Ok(result) => result,
                Err(_) => {
                    tracing::warn!(
                        timeout_ms = server_shutdown_timeout_ms,
                        "server drain deadline elapsed; closing remaining connections"
                    );
                    Ok(())
                }
            }
        }
    };
    jobs.shutdown().await;
    result?;
    Ok(())
}

async fn run_backup_command(args: Vec<String>) -> anyhow::Result<()> {
    match args.as_slice() {
        [command, destination] if command == "create" => {
            let config = Config::from_env();
            let report = full_backup::create(&config, PathBuf::from(destination).as_path()).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        [command, source] if command == "verify" => {
            let manifest = full_backup::verify(PathBuf::from(source).as_path()).await?;
            println!("{}", serde_json::to_string_pretty(&manifest)?);
        }
        [command, source, force] if command == "restore" && force == "--force" => {
            let config = Config::from_env();
            let report =
                full_backup::restore(&config, PathBuf::from(source).as_path(), true).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        _ => anyhow::bail!(
            "usage: realtime-server backup create DESTINATION | verify BACKUP | \
             restore BACKUP --force"
        ),
    }
    Ok(())
}

async fn run_crdt_command(args: Vec<String>) -> anyhow::Result<()> {
    let default_store =
        || PathBuf::from(std::env::var("CRDT_STORE").unwrap_or_else(|_| "./crdt".to_string()));
    match args.as_slice() {
        [command] if command == "inspect" || command == "repair" => {
            let report = inspect_store(&default_store(), command == "repair").await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if report.corrupt != 0 {
                anyhow::bail!("{} corrupt document(s) remain", report.corrupt);
            }
        }
        [command, path] if command == "inspect" || command == "repair" => {
            let report = inspect_store(PathBuf::from(path).as_path(), command == "repair").await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if report.corrupt != 0 {
                anyhow::bail!("{} corrupt document(s) remain", report.corrupt);
            }
        }
        [command, source] if command == "import-ysweet" => {
            let report =
                import_ysweet_store(PathBuf::from(source).as_path(), &default_store()).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.errors.is_empty() {
                anyhow::bail!("{} document(s) could not be imported", report.errors.len());
            }
        }
        [command, source, destination] if command == "import-ysweet" => {
            let report = import_ysweet_store(
                PathBuf::from(source).as_path(),
                PathBuf::from(destination).as_path(),
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.errors.is_empty() {
                anyhow::bail!("{} document(s) could not be imported", report.errors.len());
            }
        }
        [command, source, destination, pid] if command == "migrate-ysweet-cutover" => {
            let pid: i32 = pid.parse()?;
            #[cfg(unix)]
            {
                use nix::errno::Errno;
                use nix::sys::signal::{kill, Signal};
                use nix::unistd::Pid;

                let pid = Pid::from_raw(pid);
                kill(pid, Signal::SIGTERM).map_err(|error| {
                    anyhow::anyhow!("failed to signal y-sweet process {pid}: {error}")
                })?;
                while match kill(pid, None) {
                    Ok(()) | Err(Errno::EPERM) => true,
                    Err(Errno::ESRCH) => false,
                    Err(error) => {
                        return Err(anyhow::anyhow!(
                            "failed to check y-sweet process {pid}: {error}"
                        ));
                    }
                } {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
            #[cfg(not(unix))]
            anyhow::bail!("live y-sweet migration requires Unix process signaling");
            let report = import_ysweet_store(
                PathBuf::from(source).as_path(),
                PathBuf::from(destination).as_path(),
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.errors.is_empty() {
                anyhow::bail!("{} document(s) could not be imported", report.errors.len());
            }
        }
        _ => anyhow::bail!(
            "usage: realtime-server crdt inspect [STORE] | repair [STORE] | \
             import-ysweet SOURCE [STORE] | \
             migrate-ysweet-cutover SOURCE STORE YSWEET_PID"
        ),
    }
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
