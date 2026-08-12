use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::{Duration, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use apalis::layers::retry::{HasherRng, RetryPolicy};
use apalis::prelude::*;
use apalis_sqlite::{Config as ApalisConfig, SqliteStorage, SqliteTask, TaskBuilderExt};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tokio::sync::{watch, Mutex, OwnedMutexGuard};
use tower::retry::backoff::{ExponentialBackoffMaker, MakeBackoff};

use crate::entities::{git_backups, plugin_db_replicas, vaults};
use crate::session::now_millis;
use crate::state::{AppState, Principal};

const QUEUE_NAME: &str = "realtime-background";
const SEARCH_DEBOUNCE_MS: u64 = 250;
const DISPATCH_INTERVAL: Duration = Duration::from_secs(5);
const WORKER_KEEP_ALIVE: Duration = Duration::from_secs(1);
const ORPHAN_AFTER: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum JobPayload {
    SearchVault {
        vault_id: String,
    },
    SearchNote {
        vault_id: String,
        guid: String,
    },
    GitReconcile {
        vault_id: String,
    },
    PluginDbReconcile {
        vault_id: String,
        plugin: String,
        name: String,
    },
    BackupPush {
        vault_id: String,
    },
}

impl JobPayload {
    fn intent_key(&self) -> String {
        match self {
            Self::SearchVault { vault_id } => component_key("search-vault", &[vault_id]),
            Self::SearchNote { vault_id, guid } => component_key("search-note", &[vault_id, guid]),
            Self::GitReconcile { vault_id } => component_key("git", &[vault_id]),
            Self::PluginDbReconcile {
                vault_id,
                plugin,
                name,
            } => component_key("plugin-db", &[vault_id, plugin, name]),
            Self::BackupPush { vault_id } => component_key("backup", &[vault_id]),
        }
    }

    /// All derived work for one vault is serialized. Besides protecting Git's
    /// working tree, this keeps plugin-DB dumps and search rows from racing the
    /// Git materialization that consumes them.
    fn execution_key(&self) -> &str {
        match self {
            Self::SearchVault { vault_id }
            | Self::SearchNote { vault_id, .. }
            | Self::GitReconcile { vault_id }
            | Self::PluginDbReconcile { vault_id, .. }
            | Self::BackupPush { vault_id } => vault_id,
        }
    }
}

fn component_key(kind: &str, components: &[&String]) -> String {
    // JSON is an unambiguous length-aware encoding even when an external plugin
    // chooses punctuation in a database name.
    format!(
        "{kind}:{}",
        serde_json::to_string(components).expect("string components serialize")
    )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ReconcileTask {
    intent_key: String,
    generation: i64,
}

struct Intent {
    revision: i64,
    completed_revision: i64,
    active_generation: i64,
    run_after_ms: i64,
    payload: JobPayload,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub intent_key: String,
    pub payload: serde_json::Value,
    pub status: String,
    pub revision: i64,
    pub completed_revision: i64,
    pub attempts: i64,
    pub max_attempts: i64,
    pub run_after_ms: i64,
    pub updated_at: i64,
    pub last_error: Option<String>,
}

struct Inner {
    pool: SqlitePool,
    apalis: ApalisConfig,
    enabled: bool,
    concurrency: usize,
    max_attempts: u32,
    retry_min: Duration,
    retry_max: Duration,
    shutdown_timeout: Duration,
    shutdown: watch::Sender<bool>,
    handles: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    execution_locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
}

/// Durable desired-state jobs backed by Apalis 1.0's SQLite storage.
///
/// `background_job_intents` is both the coalescing record and the transactional
/// outbox. One Apalis task owns an active intent generation; writes only advance
/// the desired revision and deadline. The worker loops until it completes the
/// newest revision, so update bursts do not create one queue row per CRDT frame.
#[derive(Clone)]
pub struct JobQueue(Arc<Inner>);

impl JobQueue {
    pub async fn new(
        state_db: &sea_orm::DatabaseConnection,
        config: &crate::config::Config,
    ) -> Result<Self> {
        let pool = state_db.get_sqlite_connection_pool().clone();
        SqliteStorage::setup(&pool)
            .await
            .context("initialize Apalis SQLite schema")?;
        let apalis = ApalisConfig::new(QUEUE_NAME)
            .set_keep_alive(WORKER_KEEP_ALIVE)
            .set_reenqueue_orphaned_after(ORPHAN_AFTER)
            .set_buffer_size(config.background_job_concurrency.max(1) * 2);
        let (shutdown, _) = watch::channel(false);
        Ok(Self(Arc::new(Inner {
            pool,
            apalis,
            enabled: config.background_jobs_enabled,
            concurrency: config.background_job_concurrency.max(1),
            max_attempts: config.background_job_max_attempts.max(1),
            retry_min: Duration::from_millis(config.background_job_retry_min_ms),
            retry_max: Duration::from_millis(
                config
                    .background_job_retry_max_ms
                    .max(config.background_job_retry_min_ms)
                    .max(1),
            ),
            shutdown_timeout: Duration::from_millis(config.background_job_shutdown_timeout_ms),
            shutdown,
            handles: Mutex::new(Vec::new()),
            execution_locks: Mutex::new(HashMap::new()),
        })))
    }

    pub async fn start(&self, state: AppState) -> Result<()> {
        if !self.0.enabled {
            tracing::warn!("persistent background job workers are disabled");
            return Ok(());
        }

        // A prior process can leave a task locked or can die between updating an
        // intent and inserting its Apalis task. Rotate generations so recovery
        // is immediate instead of waiting for the abandoned-worker timeout.
        self.rotate_pending_generations().await?;
        self.schedule_startup_reconciliation(&state).await?;
        self.dispatch_pending().await?;

        let backend =
            SqliteStorage::<ReconcileTask, (), ()>::new_with_config(&self.0.pool, &self.0.apalis);
        let backoff = ExponentialBackoffMaker::<HasherRng>::new(
            self.0.retry_min,
            self.0.retry_max,
            0.2,
            HasherRng::default(),
        )
        .expect("validated background retry interval")
        .make_backoff();
        let worker_name = format!("{QUEUE_NAME}-{}", nanoid::nanoid!(8));
        let worker = WorkerBuilder::new(worker_name)
            .backend(backend)
            .data(state)
            .concurrency(self.0.concurrency)
            .retry(
                RetryPolicy::retries(self.0.max_attempts.saturating_sub(1) as usize)
                    .with_backoff(backoff),
            )
            .build(run_reconcile_task);
        let mut worker_shutdown = self.0.shutdown.subscribe();
        let worker_handle = tokio::spawn(async move {
            let signal = async move {
                wait_for_shutdown(&mut worker_shutdown).await;
                Ok::<(), WorkerError>(())
            };
            if let Err(error) = worker.run_until(signal).await {
                tracing::error!("background job worker stopped: {error}");
            }
        });

        let queue = self.clone();
        let mut dispatcher_shutdown = self.0.shutdown.subscribe();
        let dispatcher_handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(DISPATCH_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        if let Err(error) = queue.dispatch_pending().await {
                            tracing::error!("background job outbox dispatch failed: {error:#}");
                        }
                    }
                    changed = dispatcher_shutdown.changed() => {
                        if changed.is_err() || *dispatcher_shutdown.borrow() {
                            break;
                        }
                    }
                }
            }
        });

        self.0
            .handles
            .lock()
            .await
            .extend([worker_handle, dispatcher_handle]);
        Ok(())
    }

    pub async fn shutdown(&self) {
        let _ = self.0.shutdown.send(true);
        let handles = std::mem::take(&mut *self.0.handles.lock().await);
        for mut handle in handles {
            if tokio::time::timeout(self.0.shutdown_timeout, &mut handle)
                .await
                .is_err()
            {
                handle.abort();
                let _ = handle.await;
            }
        }
    }

    pub async fn list(&self) -> Result<Vec<JobView>> {
        let rows = sqlx::query(
            "SELECT intent_key,payload_json,revision,completed_revision,terminal_revision,\
                    generation,active_generation,run_after_ms,updated_at,last_error \
             FROM background_job_intents ORDER BY updated_at DESC,intent_key",
        )
        .fetch_all(&self.0.pool)
        .await?;
        let mut jobs = Vec::with_capacity(rows.len());
        for row in rows {
            let intent_key: String = row.try_get("intent_key")?;
            let revision: i64 = row.try_get("revision")?;
            let completed_revision: i64 = row.try_get("completed_revision")?;
            let terminal_revision: i64 = row.try_get("terminal_revision")?;
            let active_generation: i64 = row.try_get("active_generation")?;
            let generation = if active_generation == 0 {
                row.try_get("generation")?
            } else {
                active_generation
            };
            let queue_row = sqlx::query(
                "SELECT status,attempts,max_attempts FROM Jobs \
                 WHERE idempotency_key=? ORDER BY rowid DESC LIMIT 1",
            )
            .bind(format!("{intent_key}:{generation}"))
            .fetch_optional(&self.0.pool)
            .await?;
            let (queue_status, attempts, max_attempts) = match queue_row {
                Some(queue_row) => (
                    queue_row.try_get::<String, _>("status")?,
                    queue_row.try_get("attempts")?,
                    queue_row.try_get("max_attempts")?,
                ),
                None => ("Pending".to_string(), 0, i64::from(self.0.max_attempts)),
            };
            let status = if terminal_revision >= revision {
                "failed".to_string()
            } else if completed_revision >= revision {
                "completed".to_string()
            } else {
                queue_status.to_ascii_lowercase()
            };
            jobs.push(JobView {
                intent_key,
                payload: serde_json::from_str(row.try_get("payload_json")?)?,
                status,
                revision,
                completed_revision,
                attempts,
                max_attempts,
                run_after_ms: row.try_get("run_after_ms")?,
                updated_at: row.try_get("updated_at")?,
                last_error: row.try_get("last_error")?,
            });
        }
        Ok(jobs)
    }

    pub async fn retry(&self, intent_key: &str) -> Result<()> {
        let row = sqlx::query(
            "UPDATE background_job_intents SET \
                 terminal_revision=0,generation=generation+1,\
                 active_generation=generation+1,run_after_ms=?,updated_at=?,last_error=NULL \
             WHERE intent_key=? AND active_generation=0 AND terminal_revision>=revision \
             RETURNING active_generation,run_after_ms",
        )
        .bind(now_millis())
        .bind(now_millis())
        .bind(intent_key)
        .fetch_optional(&self.0.pool)
        .await?
        .ok_or_else(|| anyhow!("job is not in terminal failure: {intent_key}"))?;
        self.dispatch_task(
            intent_key,
            row.try_get("active_generation")?,
            row.try_get("run_after_ms")?,
        )
        .await
    }

    pub async fn cancel(&self, intent_key: &str) -> Result<()> {
        let mut transaction = self.0.pool.begin().await?;
        let result = sqlx::query(
            "UPDATE background_job_intents SET \
                 completed_revision=revision,terminal_revision=0,active_generation=0,\
                 updated_at=?,last_error=NULL WHERE intent_key=?",
        )
        .bind(now_millis())
        .bind(intent_key)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() == 0 {
            return Err(anyhow!("unknown job intent: {intent_key}"));
        }
        sqlx::query("DELETE FROM background_job_contributors WHERE intent_key=?")
            .bind(intent_key)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn enqueue_search_vault(&self, vault_id: &str) -> Result<()> {
        self.enqueue(
            JobPayload::SearchVault {
                vault_id: vault_id.to_string(),
            },
            Duration::from_millis(SEARCH_DEBOUNCE_MS),
            None,
        )
        .await
    }

    pub async fn enqueue_search_note(&self, vault_id: &str, guid: &str) -> Result<()> {
        self.enqueue(
            JobPayload::SearchNote {
                vault_id: vault_id.to_string(),
                guid: guid.to_string(),
            },
            Duration::from_millis(SEARCH_DEBOUNCE_MS),
            None,
        )
        .await
    }

    pub async fn enqueue_git(
        &self,
        vault_id: &str,
        principal: &Principal,
        delay: Duration,
    ) -> Result<()> {
        self.enqueue(
            JobPayload::GitReconcile {
                vault_id: vault_id.to_string(),
            },
            delay,
            Some(principal),
        )
        .await
    }

    pub async fn enqueue_plugin_db(
        &self,
        vault_id: &str,
        plugin: &str,
        name: &str,
        delay: Duration,
    ) -> Result<()> {
        self.enqueue(
            JobPayload::PluginDbReconcile {
                vault_id: vault_id.to_string(),
                plugin: plugin.to_string(),
                name: name.to_string(),
            },
            delay,
            None,
        )
        .await
    }

    pub async fn enqueue_backup(&self, vault_id: &str) -> Result<()> {
        self.enqueue(
            JobPayload::BackupPush {
                vault_id: vault_id.to_string(),
            },
            Duration::ZERO,
            None,
        )
        .await
    }

    async fn enqueue(
        &self,
        payload: JobPayload,
        delay: Duration,
        contributor: Option<&Principal>,
    ) -> Result<()> {
        let intent_key = payload.intent_key();
        let payload_json = serde_json::to_string(&payload)?;
        let now = now_millis();
        let delay_ms = i64::try_from(delay.as_millis()).unwrap_or(i64::MAX);
        let run_after_ms = now.saturating_add(delay_ms);
        let mut transaction = self.0.pool.begin().await?;
        let row = sqlx::query(
            "INSERT INTO background_job_intents(\
                 intent_key,payload_json,revision,completed_revision,terminal_revision,generation,\
                 active_generation,run_after_ms,updated_at,last_error\
             ) VALUES(?,?,1,0,0,1,1,?,?,NULL) \
             ON CONFLICT(intent_key) DO UPDATE SET \
                 payload_json=excluded.payload_json, \
                 revision=background_job_intents.revision+1, \
                 generation=CASE WHEN background_job_intents.active_generation=0 \
                     THEN background_job_intents.generation+1 \
                     ELSE background_job_intents.generation END, \
                 active_generation=CASE WHEN background_job_intents.active_generation=0 \
                     THEN background_job_intents.generation+1 \
                     ELSE background_job_intents.active_generation END, \
                 run_after_ms=excluded.run_after_ms, \
                 updated_at=excluded.updated_at, last_error=NULL \
             RETURNING active_generation,run_after_ms,revision",
        )
        .bind(&intent_key)
        .bind(payload_json)
        .bind(run_after_ms)
        .bind(now)
        .fetch_one(&mut *transaction)
        .await?;
        let generation: i64 = row.try_get("active_generation")?;
        let effective_run_after: i64 = row.try_get("run_after_ms")?;
        let revision: i64 = row.try_get("revision")?;

        if let Some(principal) = contributor {
            sqlx::query(
                "INSERT INTO background_job_contributors(\
                     intent_key,actor_key,principal_json,revision\
                 ) VALUES(?,?,?,?) ON CONFLICT(intent_key,revision,actor_key) DO UPDATE SET \
                 principal_json=excluded.principal_json",
            )
            .bind(&intent_key)
            .bind(principal.actor_key())
            .bind(serde_json::to_string(principal)?)
            .bind(revision)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;

        self.dispatch_task(&intent_key, generation, effective_run_after)
            .await
    }

    async fn dispatch_task(
        &self,
        intent_key: &str,
        generation: i64,
        run_after_ms: i64,
    ) -> Result<()> {
        let mut backend =
            SqliteStorage::<ReconcileTask, (), ()>::new_with_config(&self.0.pool, &self.0.apalis);
        let run_at = UNIX_EPOCH
            + Duration::from_millis(u64::try_from(run_after_ms.max(0)).unwrap_or(u64::MAX));
        let task: SqliteTask<ReconcileTask> = Task::builder(ReconcileTask {
            intent_key: intent_key.to_string(),
            generation,
        })
        .run_at_time(run_at)
        .max_attempts(self.0.max_attempts)
        .with_idempotency_key(format!("{intent_key}:{generation}"))
        .build();
        backend
            .push_task(task)
            .await
            .map_err(|error| anyhow!(error.to_string()))
    }

    async fn dispatch_pending(&self) -> Result<()> {
        let rows = sqlx::query(
            "SELECT intent_key,active_generation,run_after_ms \
             FROM background_job_intents \
             WHERE revision>completed_revision AND revision>terminal_revision \
               AND active_generation<>0",
        )
        .fetch_all(&self.0.pool)
        .await?;
        for row in rows {
            self.dispatch_task(
                row.try_get("intent_key")?,
                row.try_get("active_generation")?,
                row.try_get("run_after_ms")?,
            )
            .await?;
        }
        Ok(())
    }

    async fn rotate_pending_generations(&self) -> Result<()> {
        sqlx::query(
            "UPDATE background_job_intents SET \
                 generation=generation+1, active_generation=generation+1, updated_at=? \
             WHERE revision>completed_revision AND revision>terminal_revision",
        )
        .bind(now_millis())
        .execute(&self.0.pool)
        .await?;
        Ok(())
    }

    async fn schedule_startup_reconciliation(&self, state: &AppState) -> Result<()> {
        for vault in vaults::Entity::find().all(&state.db).await? {
            self.enqueue_search_vault(&vault.id).await?;
            if state.config.git_enabled {
                self.enqueue(
                    JobPayload::GitReconcile { vault_id: vault.id },
                    Duration::from_millis(state.config.git_debounce_ms),
                    None,
                )
                .await?;
            }
        }
        for replica in plugin_db_replicas::Entity::find()
            .filter(plugin_db_replicas::Column::Deleted.eq(false))
            .all(&state.db)
            .await?
        {
            self.enqueue_plugin_db(
                &replica.vault_id,
                &replica.plugin_id,
                &replica.name,
                Duration::ZERO,
            )
            .await?;
        }
        for backup in git_backups::Entity::find()
            .filter(git_backups::Column::Enabled.eq(true))
            .all(&state.db)
            .await?
        {
            self.enqueue_backup(&backup.vault_id).await?;
        }
        Ok(())
    }

    async fn execute(
        &self,
        state: &AppState,
        task: ReconcileTask,
        terminal_on_failure: bool,
    ) -> Result<()> {
        loop {
            let Some(intent) = self.load_intent(&task.intent_key).await? else {
                return Ok(());
            };
            if intent.active_generation != task.generation
                || intent.completed_revision >= intent.revision
            {
                return Ok(());
            }
            sleep_until(intent.run_after_ms).await;

            let execution_key = intent.payload.execution_key().to_string();
            let _guard = self.execution_lock(&execution_key).await;
            let Some(intent) = self.load_intent(&task.intent_key).await? else {
                return Ok(());
            };
            if intent.active_generation != task.generation
                || intent.completed_revision >= intent.revision
            {
                return Ok(());
            }
            if intent.run_after_ms > now_millis() {
                continue;
            }

            let revision = intent.revision;
            let result = self
                .execute_payload(state, &task.intent_key, revision, &intent.payload)
                .await;
            match result {
                Ok(()) => {
                    if self
                        .complete_intent(&task.intent_key, task.generation, revision)
                        .await?
                    {
                        return Ok(());
                    }
                    // A write arrived during execution. The same Apalis task owns
                    // this active generation and reconciles the newer revision.
                }
                Err(error) => {
                    self.record_error(
                        &task.intent_key,
                        task.generation,
                        terminal_on_failure,
                        &error,
                    )
                    .await?;
                    return Err(error);
                }
            }
        }
    }

    async fn execute_payload(
        &self,
        state: &AppState,
        intent_key: &str,
        _revision: i64,
        payload: &JobPayload,
    ) -> Result<()> {
        match payload {
            JobPayload::SearchVault { vault_id } => {
                state.search.reconcile_vault(state, vault_id).await?;
            }
            JobPayload::SearchNote { vault_id, guid } => {
                state.search.reconcile_note(state, vault_id, guid).await?;
            }
            JobPayload::GitReconcile { vault_id } => {
                state.git.reconcile(vault_id, intent_key, _revision).await?;
            }
            JobPayload::PluginDbReconcile {
                vault_id,
                plugin,
                name,
            } => {
                state
                    .plugindb
                    .replicate_once(vault_id, plugin, name)
                    .await?;
            }
            JobPayload::BackupPush { vault_id } => {
                state.git.push_backup(vault_id).await?;
            }
        }
        Ok(())
    }

    async fn load_intent(&self, intent_key: &str) -> Result<Option<Intent>> {
        let row = sqlx::query(
            "SELECT payload_json,revision,completed_revision,active_generation,run_after_ms \
             FROM background_job_intents WHERE intent_key=?",
        )
        .bind(intent_key)
        .fetch_optional(&self.0.pool)
        .await?;
        row.map(|row| {
            Ok(Intent {
                revision: row.try_get("revision")?,
                completed_revision: row.try_get("completed_revision")?,
                active_generation: row.try_get("active_generation")?,
                run_after_ms: row.try_get("run_after_ms")?,
                payload: serde_json::from_str(row.try_get("payload_json")?)?,
            })
        })
        .transpose()
    }

    pub(crate) async fn load_contributors(
        &self,
        intent_key: &str,
        revision: i64,
    ) -> Result<(i64, Vec<Principal>)> {
        let mut transaction = self.0.pool.begin().await?;
        let rows = sqlx::query(
            "SELECT principal_json FROM background_job_contributors \
             WHERE intent_key=? AND revision<=? \
             GROUP BY actor_key ORDER BY actor_key",
        )
        .bind(intent_key)
        .bind(revision)
        .fetch_all(&mut *transaction)
        .await?;
        let contributors = rows
            .into_iter()
            .map(|row| Ok(serde_json::from_str(row.try_get("principal_json")?)?))
            .collect::<Result<Vec<_>>>()?;
        transaction.commit().await?;
        Ok((revision, contributors))
    }

    async fn complete_intent(
        &self,
        intent_key: &str,
        generation: i64,
        revision: i64,
    ) -> Result<bool> {
        let mut transaction = self.0.pool.begin().await?;
        let result = sqlx::query(
            "UPDATE background_job_intents SET completed_revision=?,active_generation=0,\
                 last_error=NULL,updated_at=? \
             WHERE intent_key=? AND active_generation=? AND revision=?",
        )
        .bind(revision)
        .bind(now_millis())
        .bind(intent_key)
        .bind(generation)
        .bind(revision)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(result.rows_affected() == 1)
    }

    pub(crate) async fn clear_contributors(&self, intent_key: &str, revision: i64) -> Result<()> {
        sqlx::query("DELETE FROM background_job_contributors WHERE intent_key=? AND revision<=?")
            .bind(intent_key)
            .bind(revision)
            .execute(&self.0.pool)
            .await?;
        Ok(())
    }

    async fn record_error(
        &self,
        intent_key: &str,
        generation: i64,
        terminal: bool,
        error: &anyhow::Error,
    ) -> Result<()> {
        if terminal {
            let result = sqlx::query(
                "UPDATE background_job_intents SET \
                     terminal_revision=revision,active_generation=0,last_error=?,updated_at=? \
                 WHERE intent_key=? AND active_generation=?",
            )
            .bind(format!("{error:#}"))
            .bind(now_millis())
            .bind(intent_key)
            .bind(generation)
            .execute(&self.0.pool)
            .await?;
            if result.rows_affected() == 1 {
                return Ok(());
            }
        }
        sqlx::query(
            "UPDATE background_job_intents SET last_error=?,updated_at=? \
             WHERE intent_key=? AND active_generation=?",
        )
        .bind(format!("{error:#}"))
        .bind(now_millis())
        .bind(intent_key)
        .bind(generation)
        .execute(&self.0.pool)
        .await?;
        Ok(())
    }

    async fn execution_lock(&self, key: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.0.execution_locks.lock().await;
            locks.retain(|_, lock| lock.strong_count() > 0);
            match locks.get(key).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(Mutex::new(()));
                    locks.insert(key.to_string(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        lock.lock_owned().await
    }
}

async fn run_reconcile_task(
    task: ReconcileTask,
    state: Data<AppState>,
    attempt: Attempt,
) -> Result<(), BoxDynError> {
    let terminal = attempt.current() >= state.config.background_job_max_attempts as usize;
    state
        .jobs
        .execute(&state, task, terminal)
        .await
        .map_err(Into::into)
}

async fn wait_for_shutdown(receiver: &mut watch::Receiver<bool>) {
    while !*receiver.borrow() {
        if receiver.changed().await.is_err() {
            break;
        }
    }
}

async fn sleep_until(timestamp_ms: i64) {
    let remaining = timestamp_ms.saturating_sub(now_millis());
    if remaining > 0 {
        tokio::time::sleep(Duration::from_millis(remaining as u64)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::Database;

    async fn queue() -> JobQueue {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        crate::db::migrate_schema(&db).await.unwrap();
        let mut config = crate::config::Config::test_default();
        config.background_jobs_enabled = false;
        JobQueue::new(&db, &config).await.unwrap()
    }

    #[tokio::test]
    async fn repeated_writes_coalesce_into_one_active_generation() {
        let queue = queue().await;
        queue.enqueue_search_note("vault", "guid").await.unwrap();
        queue.enqueue_search_note("vault", "guid").await.unwrap();
        queue.enqueue_search_note("vault", "guid").await.unwrap();

        let key = JobPayload::SearchNote {
            vault_id: "vault".into(),
            guid: "guid".into(),
        }
        .intent_key();
        let intent = queue.load_intent(&key).await.unwrap().unwrap();
        assert_eq!(intent.revision, 3);
        assert_eq!(intent.completed_revision, 0);
        assert_eq!(intent.active_generation, 1);

        let queued: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM Jobs WHERE job_type=? AND idempotency_key=?")
                .bind(QUEUE_NAME)
                .bind(format!("{key}:1"))
                .fetch_one(&queue.0.pool)
                .await
                .unwrap();
        assert_eq!(queued, 1);
    }

    #[tokio::test]
    async fn restart_rotation_invalidates_the_old_task_generation() {
        let queue = queue().await;
        queue.enqueue_search_vault("vault").await.unwrap();
        let key = JobPayload::SearchVault {
            vault_id: "vault".into(),
        }
        .intent_key();

        queue.rotate_pending_generations().await.unwrap();
        queue.dispatch_pending().await.unwrap();
        let intent = queue.load_intent(&key).await.unwrap().unwrap();
        assert_eq!(intent.active_generation, 2);

        let generations: Vec<String> = sqlx::query_scalar(
            "SELECT idempotency_key FROM Jobs WHERE job_type=? ORDER BY idempotency_key",
        )
        .bind(QUEUE_NAME)
        .fetch_all(&queue.0.pool)
        .await
        .unwrap();
        assert_eq!(generations, vec![format!("{key}:1"), format!("{key}:2")]);
    }

    #[tokio::test]
    async fn contributors_are_deduplicated_by_actor() {
        let queue = queue().await;
        let principal = Principal {
            user_id: "user".into(),
            display_name: "User".into(),
            email: "user@example.com".into(),
            git_email: None,
            actor: crate::state::PrincipalActor::User,
            expires_at_ms: i64::MAX,
        };
        queue
            .enqueue_git("vault", &principal, Duration::ZERO)
            .await
            .unwrap();
        queue
            .enqueue_git("vault", &principal, Duration::ZERO)
            .await
            .unwrap();
        let key = JobPayload::GitReconcile {
            vault_id: "vault".into(),
        }
        .intent_key();
        assert_eq!(
            queue.load_contributors(&key, 2).await.unwrap().1,
            vec![principal]
        );
    }

    #[tokio::test]
    async fn later_write_by_same_actor_does_not_steal_earlier_revision_attribution() {
        let queue = queue().await;
        let principal = Principal {
            user_id: "user".into(),
            display_name: "User".into(),
            email: "user@example.com".into(),
            git_email: None,
            actor: crate::state::PrincipalActor::User,
            expires_at_ms: i64::MAX,
        };
        queue
            .enqueue_git("vault", &principal, Duration::ZERO)
            .await
            .unwrap();
        let key = JobPayload::GitReconcile {
            vault_id: "vault".into(),
        }
        .intent_key();

        let claimed = queue.load_contributors(&key, 1).await.unwrap();
        queue
            .enqueue_git("vault", &principal, Duration::ZERO)
            .await
            .unwrap();

        assert_eq!(claimed, (1, vec![principal.clone()]));
        queue.clear_contributors(&key, claimed.0).await.unwrap();
        assert_eq!(
            queue.load_contributors(&key, 2).await.unwrap(),
            (2, vec![principal])
        );
    }

    #[tokio::test]
    async fn failed_completion_preserves_contributors_for_the_next_reconcile() {
        let queue = queue().await;
        let first = Principal {
            user_id: "first".into(),
            display_name: "First".into(),
            email: "first@example.com".into(),
            git_email: None,
            actor: crate::state::PrincipalActor::User,
            expires_at_ms: i64::MAX,
        };
        let second = Principal {
            user_id: "second".into(),
            display_name: "Second".into(),
            email: "second@example.com".into(),
            git_email: None,
            actor: crate::state::PrincipalActor::User,
            expires_at_ms: i64::MAX,
        };
        queue
            .enqueue_git("vault", &first, Duration::ZERO)
            .await
            .unwrap();
        let key = JobPayload::GitReconcile {
            vault_id: "vault".into(),
        }
        .intent_key();
        queue
            .enqueue_git("vault", &second, Duration::ZERO)
            .await
            .unwrap();

        assert_eq!(
            queue.load_contributors(&key, 2).await.unwrap().1,
            vec![first, second]
        );
        assert!(!queue.complete_intent(&key, 1, 1).await.unwrap());
        assert_eq!(queue.load_contributors(&key, 2).await.unwrap().1.len(), 2);
    }

    #[tokio::test]
    async fn completion_never_acknowledges_a_newer_revision() {
        let queue = queue().await;
        queue.enqueue_search_vault("vault").await.unwrap();
        let key = JobPayload::SearchVault {
            vault_id: "vault".into(),
        }
        .intent_key();
        queue.enqueue_search_vault("vault").await.unwrap();

        assert!(!queue.complete_intent(&key, 1, 1).await.unwrap());
        let intent = queue.load_intent(&key).await.unwrap().unwrap();
        assert_eq!(intent.revision, 2);
        assert_eq!(intent.completed_revision, 0);
        assert_eq!(intent.active_generation, 1);

        assert!(queue.complete_intent(&key, 1, 2).await.unwrap());
        let intent = queue.load_intent(&key).await.unwrap().unwrap();
        assert_eq!(intent.completed_revision, 2);
        assert_eq!(intent.active_generation, 0);
    }

    #[tokio::test]
    async fn terminal_failure_requires_explicit_retry_or_new_work() {
        let queue = queue().await;
        queue.enqueue_search_vault("vault").await.unwrap();
        let key = JobPayload::SearchVault {
            vault_id: "vault".into(),
        }
        .intent_key();
        let error = anyhow!("permanent failure");
        queue.record_error(&key, 1, true, &error).await.unwrap();

        let failed = queue
            .list()
            .await
            .unwrap()
            .into_iter()
            .find(|job| job.intent_key == key)
            .unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.last_error.as_deref(), Some("permanent failure"));

        queue.rotate_pending_generations().await.unwrap();
        assert_eq!(
            queue
                .load_intent(&key)
                .await
                .unwrap()
                .unwrap()
                .active_generation,
            0
        );

        queue.retry(&key).await.unwrap();
        assert_eq!(
            queue
                .load_intent(&key)
                .await
                .unwrap()
                .unwrap()
                .active_generation,
            2
        );
        assert!(queue.retry(&key).await.is_err());

        queue.cancel(&key).await.unwrap();
        let canceled = queue.load_intent(&key).await.unwrap().unwrap();
        assert_eq!(canceled.completed_revision, canceled.revision);
        assert_eq!(canceled.active_generation, 0);

        queue.enqueue_search_vault("vault").await.unwrap();
        let resumed = queue.load_intent(&key).await.unwrap().unwrap();
        assert_eq!(resumed.revision, 2);
        assert_eq!(resumed.active_generation, 3);
    }

    #[tokio::test]
    async fn terminal_failure_covers_a_revision_enqueued_during_execution() {
        let queue = queue().await;
        queue.enqueue_search_vault("vault").await.unwrap();
        let key = JobPayload::SearchVault {
            vault_id: "vault".into(),
        }
        .intent_key();

        // The worker loaded revision 1, then a write advanced the desired state
        // before the worker recorded its final failed attempt.
        queue.enqueue_search_vault("vault").await.unwrap();
        queue
            .record_error(&key, 1, true, &anyhow!("final attempt failed"))
            .await
            .unwrap();

        let intent = queue.load_intent(&key).await.unwrap().unwrap();
        assert_eq!(intent.revision, 2);
        assert_eq!(intent.active_generation, 0);
        let failed = queue
            .list()
            .await
            .unwrap()
            .into_iter()
            .find(|job| job.intent_key == key)
            .unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.revision, 2);

        queue.enqueue_search_vault("vault").await.unwrap();
        let resumed = queue.load_intent(&key).await.unwrap().unwrap();
        assert_eq!(resumed.revision, 3);
        assert_eq!(resumed.active_generation, 2);
    }

    #[tokio::test]
    async fn missing_apalis_row_is_recovered_from_the_intent_outbox() {
        let queue = queue().await;
        queue.enqueue_search_vault("vault").await.unwrap();
        let key = JobPayload::SearchVault {
            vault_id: "vault".into(),
        }
        .intent_key();
        sqlx::query("DELETE FROM Jobs WHERE idempotency_key=?")
            .bind(format!("{key}:1"))
            .execute(&queue.0.pool)
            .await
            .unwrap();

        queue.rotate_pending_generations().await.unwrap();
        queue.dispatch_pending().await.unwrap();
        let recovered: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM Jobs WHERE idempotency_key=?")
                .bind(format!("{key}:2"))
                .fetch_one(&queue.0.pool)
                .await
                .unwrap();
        assert_eq!(recovered, 1);
    }

    fn persistent_config(root: &std::path::Path) -> crate::config::Config {
        let mut config = crate::config::Config::test_default();
        config.database_url = format!("sqlite://{}?mode=rwc", root.join("state.db").display());
        config.crdt_store_dir = root.join("crdt").to_string_lossy().into_owned();
        config.blob_dir = root.join("blobs").to_string_lossy().into_owned();
        config.git_data_dir = root.join("git").to_string_lossy().into_owned();
        config.git_enabled = false;
        config.background_job_concurrency = 1;
        config.background_job_max_attempts = 3;
        config.background_job_retry_min_ms = 1;
        config.background_job_retry_max_ms = 2;
        config.background_job_shutdown_timeout_ms = 2_000;
        config
    }

    async fn wait_for_job(
        queue: &JobQueue,
        intent_key: &str,
        predicate: impl Fn(&JobView) -> bool,
    ) -> JobView {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(job) = queue
                    .list()
                    .await
                    .unwrap()
                    .into_iter()
                    .find(|job| job.intent_key == intent_key)
                {
                    if predicate(&job) {
                        return job;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("job reached expected state")
    }

    #[tokio::test]
    async fn live_worker_retries_with_backoff_then_records_terminal_failure() {
        let root =
            std::env::temp_dir().join(format!("realtime-jobs-failure-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let mut config = persistent_config(&root);
        config.background_job_retry_min_ms = 30;
        config.background_job_retry_max_ms = 30;
        let state = crate::build_state(config).await.unwrap();
        let started = std::time::Instant::now();
        state.jobs.enqueue_search_vault("../escape").await.unwrap();
        let key = JobPayload::SearchVault {
            vault_id: "../escape".into(),
        }
        .intent_key();

        let failed = wait_for_job(&state.jobs, &key, |job| {
            job.status == "failed" && job.attempts == 3
        })
        .await;
        assert_eq!(failed.max_attempts, 3);
        assert!(
            started.elapsed() >= Duration::from_millis(50),
            "retry attempts did not observe configured backoff"
        );
        assert!(failed
            .last_error
            .as_deref()
            .unwrap()
            .contains("invalid document id"));

        state.jobs.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn pending_intent_survives_restart_and_executes_once_workers_resume() {
        let root =
            std::env::temp_dir().join(format!("realtime-jobs-restart-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let mut paused = persistent_config(&root);
        paused.background_jobs_enabled = false;
        let db = Database::connect(&paused.database_url).await.unwrap();
        crate::db::migrate_schema(&db).await.unwrap();
        let paused_queue = JobQueue::new(&db, &paused).await.unwrap();
        paused_queue
            .enqueue_search_vault("restart-vault")
            .await
            .unwrap();
        let key = JobPayload::SearchVault {
            vault_id: "restart-vault".into(),
        }
        .intent_key();
        drop(paused_queue);
        drop(db);

        let state = crate::build_state(persistent_config(&root)).await.unwrap();
        let completed = wait_for_job(&state.jobs, &key, |job| job.status == "completed").await;
        assert_eq!(completed.revision, completed.completed_revision);
        let generations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM Jobs WHERE idempotency_key LIKE ?")
                .bind(format!("{key}:%"))
                .fetch_one(&state.jobs.0.pool)
                .await
                .unwrap();
        assert_eq!(generations, 2);

        state.jobs.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn per_vault_execution_lock_serializes_distinct_job_intents() {
        let queue = queue().await;
        let first = queue.execution_lock("vault").await;
        let contender = {
            let queue = queue.clone();
            tokio::spawn(async move { queue.execution_lock("vault").await })
        };
        assert!(tokio::time::timeout(Duration::from_millis(25), async {
            while !contender.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_err());
        drop(first);
        let second = tokio::time::timeout(Duration::from_secs(1), contender)
            .await
            .unwrap()
            .unwrap();
        drop(second);
    }

    #[tokio::test]
    async fn forced_shutdown_leaves_inflight_intent_recoverable() {
        let root =
            std::env::temp_dir().join(format!("realtime-jobs-shutdown-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let mut first_config = persistent_config(&root);
        first_config.background_job_max_attempts = 25;
        first_config.background_job_retry_min_ms = 5_000;
        first_config.background_job_retry_max_ms = 5_000;
        first_config.background_job_shutdown_timeout_ms = 25;
        let first_state = crate::build_state(first_config.clone()).await.unwrap();
        first_state
            .jobs
            .enqueue_search_vault("../shutdown")
            .await
            .unwrap();
        let key = JobPayload::SearchVault {
            vault_id: "../shutdown".into(),
        }
        .intent_key();
        wait_for_job(&first_state.jobs, &key, |job| job.last_error.is_some()).await;

        tokio::time::timeout(Duration::from_secs(1), first_state.jobs.shutdown())
            .await
            .expect("shutdown obeyed its grace deadline");
        let interrupted = first_state.jobs.load_intent(&key).await.unwrap().unwrap();
        assert_ne!(interrupted.active_generation, 0);

        let mut second_config = first_config;
        second_config.background_job_max_attempts = 1;
        second_config.background_job_retry_min_ms = 1;
        second_config.background_job_retry_max_ms = 1;
        let second_state = crate::build_state(second_config).await.unwrap();
        let failed = wait_for_job(&second_state.jobs, &key, |job| job.status == "failed").await;
        assert_eq!(failed.max_attempts, 1);
        assert!(failed.revision > failed.completed_revision);

        second_state.jobs.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
