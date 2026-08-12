use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use sea_orm::ConnectionTrait;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use crate::state::AppState;

#[derive(Clone, Default)]
pub struct SyncMetrics(Arc<SyncMetricCounters>);

#[derive(Default)]
struct SyncMetricCounters {
    physical_connections_active: AtomicU64,
    physical_connections_total: AtomicU64,
    document_channels_active: AtomicU64,
    document_channels_total: AtomicU64,
    document_channel_rejections_total: AtomicU64,
    document_channel_backpressure_resets_total: AtomicU64,
    crdt_connections_active: AtomicU64,
    crdt_connections_total: AtomicU64,
    crdt_updates_total: AtomicU64,
    crdt_update_bytes_total: AtomicU64,
    crdt_update_failures_total: AtomicU64,
    crdt_update_latency_micros_total: AtomicU64,
    crdt_update_latency_micros_max: AtomicU64,
    crdt_compactions_total: AtomicU64,
    crdt_compaction_failures_total: AtomicU64,
    crdt_compaction_latency_micros_total: AtomicU64,
    crdt_compaction_latency_micros_max: AtomicU64,
    crdt_lagged_connections_total: AtomicU64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncMetricsSnapshot {
    pub physical_connections_active: u64,
    pub physical_connections_total: u64,
    pub document_channels_active: u64,
    pub document_channels_total: u64,
    pub document_channel_rejections_total: u64,
    pub document_channel_backpressure_resets_total: u64,
    pub crdt_connections_active: u64,
    pub crdt_connections_total: u64,
    pub crdt_updates_total: u64,
    pub crdt_update_bytes_total: u64,
    pub crdt_update_failures_total: u64,
    pub crdt_update_latency_micros_total: u64,
    pub crdt_update_latency_micros_max: u64,
    pub crdt_compactions_total: u64,
    pub crdt_compaction_failures_total: u64,
    pub crdt_compaction_latency_micros_total: u64,
    pub crdt_compaction_latency_micros_max: u64,
    pub crdt_lagged_connections_total: u64,
}

impl SyncMetrics {
    pub(crate) fn physical_connection_opened(&self) {
        self.0
            .physical_connections_active
            .fetch_add(1, Ordering::Relaxed);
        self.0
            .physical_connections_total
            .fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn physical_connection_closed(&self) {
        decrement(&self.0.physical_connections_active, 1);
    }

    pub(crate) fn document_channel_opened(&self) {
        self.0
            .document_channels_active
            .fetch_add(1, Ordering::Relaxed);
        self.0
            .document_channels_total
            .fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn document_channels_closed(&self, count: usize) {
        decrement(&self.0.document_channels_active, count as u64);
    }

    pub(crate) fn document_channel_rejected(&self) {
        self.0
            .document_channel_rejections_total
            .fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn document_channel_backpressure_reset(&self) {
        self.0
            .document_channel_backpressure_resets_total
            .fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn crdt_connection_opened(&self) {
        self.0
            .crdt_connections_active
            .fetch_add(1, Ordering::Relaxed);
        self.0
            .crdt_connections_total
            .fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn crdt_connection_closed(&self) {
        decrement(&self.0.crdt_connections_active, 1);
    }

    pub(crate) fn observe_update(&self, bytes: usize, elapsed: Duration, success: bool) {
        let micros = elapsed.as_micros().min(u64::MAX as u128) as u64;
        self.0.crdt_updates_total.fetch_add(1, Ordering::Relaxed);
        self.0
            .crdt_update_bytes_total
            .fetch_add(bytes as u64, Ordering::Relaxed);
        self.0
            .crdt_update_latency_micros_total
            .fetch_add(micros, Ordering::Relaxed);
        update_max(&self.0.crdt_update_latency_micros_max, micros);
        if !success {
            self.0
                .crdt_update_failures_total
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    pub(crate) fn observe_compaction(&self, elapsed: Duration, success: bool) {
        let micros = elapsed.as_micros().min(u64::MAX as u128) as u64;
        self.0
            .crdt_compactions_total
            .fetch_add(1, Ordering::Relaxed);
        self.0
            .crdt_compaction_latency_micros_total
            .fetch_add(micros, Ordering::Relaxed);
        update_max(&self.0.crdt_compaction_latency_micros_max, micros);
        if !success {
            self.0
                .crdt_compaction_failures_total
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    pub(crate) fn crdt_connection_lagged(&self) {
        self.0
            .crdt_lagged_connections_total
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> SyncMetricsSnapshot {
        SyncMetricsSnapshot {
            physical_connections_active: self.0.physical_connections_active.load(Ordering::Relaxed),
            physical_connections_total: self.0.physical_connections_total.load(Ordering::Relaxed),
            document_channels_active: self.0.document_channels_active.load(Ordering::Relaxed),
            document_channels_total: self.0.document_channels_total.load(Ordering::Relaxed),
            document_channel_rejections_total: self
                .0
                .document_channel_rejections_total
                .load(Ordering::Relaxed),
            document_channel_backpressure_resets_total: self
                .0
                .document_channel_backpressure_resets_total
                .load(Ordering::Relaxed),
            crdt_connections_active: self.0.crdt_connections_active.load(Ordering::Relaxed),
            crdt_connections_total: self.0.crdt_connections_total.load(Ordering::Relaxed),
            crdt_updates_total: self.0.crdt_updates_total.load(Ordering::Relaxed),
            crdt_update_bytes_total: self.0.crdt_update_bytes_total.load(Ordering::Relaxed),
            crdt_update_failures_total: self.0.crdt_update_failures_total.load(Ordering::Relaxed),
            crdt_update_latency_micros_total: self
                .0
                .crdt_update_latency_micros_total
                .load(Ordering::Relaxed),
            crdt_update_latency_micros_max: self
                .0
                .crdt_update_latency_micros_max
                .load(Ordering::Relaxed),
            crdt_compactions_total: self.0.crdt_compactions_total.load(Ordering::Relaxed),
            crdt_compaction_failures_total: self
                .0
                .crdt_compaction_failures_total
                .load(Ordering::Relaxed),
            crdt_compaction_latency_micros_total: self
                .0
                .crdt_compaction_latency_micros_total
                .load(Ordering::Relaxed),
            crdt_compaction_latency_micros_max: self
                .0
                .crdt_compaction_latency_micros_max
                .load(Ordering::Relaxed),
            crdt_lagged_connections_total: self
                .0
                .crdt_lagged_connections_total
                .load(Ordering::Relaxed),
        }
    }
}

fn decrement(value: &AtomicU64, count: u64) {
    let _ = value.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
        Some(current.saturating_sub(count))
    });
}

fn update_max(value: &AtomicU64, candidate: u64) {
    let _ = value.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
        (candidate > current).then_some(candidate)
    });
}

#[derive(Clone)]
pub struct RuntimeHealth(Arc<RuntimeHealthInner>);

struct RuntimeHealthInner {
    draining: AtomicBool,
    started: Instant,
}

impl Default for RuntimeHealth {
    fn default() -> Self {
        Self(Arc::new(RuntimeHealthInner {
            draining: AtomicBool::new(false),
            started: Instant::now(),
        }))
    }
}

impl RuntimeHealth {
    pub fn begin_draining(&self) {
        self.0.draining.store(true, Ordering::Release);
    }

    pub fn is_draining(&self) -> bool {
        self.0.draining.load(Ordering::Acquire)
    }

    pub fn uptime_seconds(&self) -> u64 {
        self.0.started.elapsed().as_secs()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    checks: HealthChecks,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthChecks {
    draining: bool,
    database: bool,
    crdt_store: bool,
    blob_store: bool,
    git_store: bool,
    restore_complete: bool,
}

pub async fn live() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "up" }))
}

pub async fn ready(State(state): State<AppState>) -> Response {
    if state.runtime_health.is_draining() {
        return health_response(
            StatusCode::SERVICE_UNAVAILABLE,
            HealthChecks {
                draining: true,
                database: true,
                crdt_store: true,
                blob_store: true,
                git_store: true,
                restore_complete: true,
            },
        );
    }

    let database = state.db.execute_unprepared("SELECT 1").await.is_ok();
    let (crdt_store, blob_store, git_store) = tokio::join!(
        writable_directory(Path::new(&state.config.crdt_store_dir)),
        writable_directory(Path::new(&state.config.blob_dir)),
        async {
            if state.config.git_enabled {
                writable_directory(Path::new(&state.config.git_data_dir)).await
            } else {
                true
            }
        },
    );
    let restore_config = state.config.clone();
    let restore_complete = tokio::task::spawn_blocking(move || {
        crate::full_backup::ensure_restore_complete(&restore_config).is_ok()
    })
    .await
    .unwrap_or(false);
    let checks = HealthChecks {
        draining: false,
        database,
        crdt_store,
        blob_store,
        git_store,
        restore_complete,
    };
    let ready = database && crdt_store && blob_store && git_store && restore_complete;
    health_response(
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        checks,
    )
}

fn health_response(status: StatusCode, checks: HealthChecks) -> Response {
    let body = HealthResponse {
        status: if status == StatusCode::OK {
            "ready"
        } else {
            "not_ready"
        },
        checks,
    };
    (status, Json(body)).into_response()
}

async fn writable_directory(path: &Path) -> bool {
    if let Err(error) = tokio::fs::create_dir_all(path).await {
        tracing::warn!(%error, path = %path.display(), "readiness directory creation failed");
        return false;
    }
    let probe = path.join(format!(
        ".realtime-readiness-{}-{}",
        std::process::id(),
        nanoid::nanoid!(12)
    ));
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&probe)
            .await?;
        file.write_all(b"ready").await?;
        file.sync_data().await?;
        drop(file);
        tokio::fs::remove_file(&probe).await
    }
    .await;
    if let Err(error) = result {
        tracing::warn!(%error, path = %path.display(), "readiness write probe failed");
        let _ = tokio::fs::remove_file(&probe).await;
        return false;
    }
    true
}

pub async fn metrics(State(state): State<AppState>) -> Response {
    let snapshot = state.sync_metrics.snapshot();
    let (live_documents, known_documents) = state.documents.residency_counts().await;
    let body = format!(
        concat!(
            "# TYPE realtime_uptime_seconds gauge\n",
            "realtime_uptime_seconds {}\n",
            "# TYPE realtime_draining gauge\n",
            "realtime_draining {}\n",
            "# TYPE realtime_sync_physical_connections_active gauge\n",
            "realtime_sync_physical_connections_active {}\n",
            "# TYPE realtime_sync_physical_connections_total counter\n",
            "realtime_sync_physical_connections_total {}\n",
            "# TYPE realtime_sync_document_channels_active gauge\n",
            "realtime_sync_document_channels_active {}\n",
            "# TYPE realtime_sync_document_channels_total counter\n",
            "realtime_sync_document_channels_total {}\n",
            "# TYPE realtime_sync_document_channel_rejections_total counter\n",
            "realtime_sync_document_channel_rejections_total {}\n",
            "# TYPE realtime_sync_document_channel_backpressure_resets_total counter\n",
            "realtime_sync_document_channel_backpressure_resets_total {}\n",
            "# TYPE realtime_crdt_connections_active gauge\n",
            "realtime_crdt_connections_active {}\n",
            "# TYPE realtime_crdt_connections_total counter\n",
            "realtime_crdt_connections_total {}\n",
            "# TYPE realtime_crdt_live_documents gauge\n",
            "realtime_crdt_live_documents {}\n",
            "# TYPE realtime_crdt_known_documents gauge\n",
            "realtime_crdt_known_documents {}\n",
            "# TYPE realtime_crdt_updates_total counter\n",
            "realtime_crdt_updates_total {}\n",
            "# TYPE realtime_crdt_update_bytes_total counter\n",
            "realtime_crdt_update_bytes_total {}\n",
            "# TYPE realtime_crdt_update_failures_total counter\n",
            "realtime_crdt_update_failures_total {}\n",
            "# TYPE realtime_crdt_update_latency_microseconds_total counter\n",
            "realtime_crdt_update_latency_microseconds_total {}\n",
            "# TYPE realtime_crdt_update_latency_microseconds_max gauge\n",
            "realtime_crdt_update_latency_microseconds_max {}\n",
            "# TYPE realtime_crdt_compactions_total counter\n",
            "realtime_crdt_compactions_total {}\n",
            "# TYPE realtime_crdt_compaction_failures_total counter\n",
            "realtime_crdt_compaction_failures_total {}\n",
            "# TYPE realtime_crdt_compaction_latency_microseconds_total counter\n",
            "realtime_crdt_compaction_latency_microseconds_total {}\n",
            "# TYPE realtime_crdt_compaction_latency_microseconds_max gauge\n",
            "realtime_crdt_compaction_latency_microseconds_max {}\n",
            "# TYPE realtime_crdt_lagged_connections_total counter\n",
            "realtime_crdt_lagged_connections_total {}\n",
            "# EOF\n"
        ),
        state.runtime_health.uptime_seconds(),
        u8::from(state.runtime_health.is_draining()),
        snapshot.physical_connections_active,
        snapshot.physical_connections_total,
        snapshot.document_channels_active,
        snapshot.document_channels_total,
        snapshot.document_channel_rejections_total,
        snapshot.document_channel_backpressure_resets_total,
        snapshot.crdt_connections_active,
        snapshot.crdt_connections_total,
        live_documents,
        known_documents,
        snapshot.crdt_updates_total,
        snapshot.crdt_update_bytes_total,
        snapshot.crdt_update_failures_total,
        snapshot.crdt_update_latency_micros_total,
        snapshot.crdt_update_latency_micros_max,
        snapshot.crdt_compactions_total,
        snapshot.crdt_compaction_failures_total,
        snapshot.crdt_compaction_latency_micros_total,
        snapshot.crdt_compaction_latency_micros_max,
        snapshot.crdt_lagged_connections_total,
    );
    (
        [(
            header::CONTENT_TYPE,
            "application/openmetrics-text; version=1.0.0; charset=utf-8",
        )],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metric_counters_track_active_and_terminal_events() {
        let metrics = SyncMetrics::default();
        metrics.physical_connection_opened();
        metrics.document_channel_opened();
        metrics.crdt_connection_opened();
        metrics.observe_update(12, Duration::from_micros(7), true);
        metrics.observe_update(4, Duration::from_micros(11), false);
        metrics.observe_compaction(Duration::from_micros(13), false);
        metrics.crdt_connection_lagged();
        metrics.document_channel_rejected();
        metrics.document_channel_backpressure_reset();
        metrics.document_channels_closed(1);
        metrics.crdt_connection_closed();
        metrics.physical_connection_closed();

        assert_eq!(
            metrics.snapshot(),
            SyncMetricsSnapshot {
                physical_connections_active: 0,
                physical_connections_total: 1,
                document_channels_active: 0,
                document_channels_total: 1,
                document_channel_rejections_total: 1,
                document_channel_backpressure_resets_total: 1,
                crdt_connections_active: 0,
                crdt_connections_total: 1,
                crdt_updates_total: 2,
                crdt_update_bytes_total: 16,
                crdt_update_failures_total: 1,
                crdt_update_latency_micros_total: 18,
                crdt_update_latency_micros_max: 11,
                crdt_compactions_total: 1,
                crdt_compaction_failures_total: 1,
                crdt_compaction_latency_micros_total: 13,
                crdt_compaction_latency_micros_max: 13,
                crdt_lagged_connections_total: 1,
            }
        );
    }

    #[test]
    fn runtime_health_enters_draining_once() {
        let health = RuntimeHealth::default();
        assert!(!health.is_draining());
        health.begin_draining();
        health.begin_draining();
        assert!(health.is_draining());
    }
}
