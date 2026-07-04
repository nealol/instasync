//! Server-side replication for synced plugin databases (cr-sqlite).
//!
//! Each plugin database lives in a per-DB Y.Doc (`{vault}__plugindb__{plugin}__{name}`)
//! whose `batches` array is an append-only cr-sqlite changelog. This service:
//!
//!  - mirrors that log into an on-disk rusqlite replica (so the server can serve
//!    bootstraps and produce deterministic git dumps), driven by the same
//!    debounce pattern as [`crate::git::GitService`];
//!  - serves the bootstrap endpoint directly from the Y.Doc batch log, so new
//!    clients can pull a full changeset even when the loadable extension is
//!    unavailable;
//!  - purges replicas + git dumps on permanent delete;
//!  - compacts the Y.Doc log once every consumer has caught up.
//!
//! Replica maintenance and git dumps require the cr-sqlite loadable extension
//! (`config.crsqlite_ext_path`). When it is unset or missing, those degrade
//! gracefully — client-to-client sync over the Y log is unaffected.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use sea_orm::{ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio::sync::Mutex;
use y_sweet_core::auth::Authenticator;
use yrs::types::ToJson;
use yrs::updates::decoder::Decode;
use yrs::{Any, Array, Doc, Map, ReadTxn, Transact, Update};

use crate::config::Config;
use crate::entities::plugin_db_replicas;
use crate::session::now_millis;
use crate::ydoc::any_to_json;

/// The cr-sqlite loadable extension's init symbol.
const CRSQLITE_INIT: &str = "sqlite3_crsqlite_init";
/// Compaction staleness window: a consumer cursor older than this is ignored.
const STALE_CURSOR_MS: i64 = 30 * 24 * 60 * 60 * 1000;

// ---------- wire types ----------

// NOTE on numbers: JavaScript clients write batch/cursor numbers into Yjs as
// float64 (lib0's Any encoding), so they surface here as JSON floats like
// `1.0`. Every integer field therefore decodes leniently (int or integral
// float) — a strict `i64` decode silently drops the whole structure.

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChangeRow {
    #[serde(rename = "table")]
    pub table: String,
    pub pk: String,
    pub cid: String,
    pub val: JsonValue,
    #[serde(deserialize_with = "lenient_i64")]
    pub col_version: i64,
    #[serde(deserialize_with = "lenient_i64")]
    pub db_version: i64,
    pub site_id: String,
    #[serde(deserialize_with = "lenient_i64")]
    pub cl: i64,
    #[serde(deserialize_with = "lenient_i64")]
    pub seq: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Batch {
    #[allow(dead_code)]
    pub id: String,
    #[serde(rename = "siteId")]
    pub site_id: String,
    #[serde(rename = "fromDbVersion", default, deserialize_with = "lenient_i64")]
    pub from_db_version: i64,
    #[serde(rename = "toDbVersion", default, deserialize_with = "lenient_i64")]
    pub to_db_version: i64,
    #[serde(rename = "schemaVersion", default, deserialize_with = "lenient_i64")]
    pub schema_version: i64,
    #[serde(default)]
    pub changes: Vec<ChangeRow>,
    #[serde(default)]
    pub format: String,
}

/// Accept an integer-valued JSON number whether it arrives as int or float.
fn json_i64(v: &JsonValue) -> Option<i64> {
    match v {
        JsonValue::Number(n) => n.as_i64().or_else(|| {
            n.as_f64()
                .filter(|f| f.is_finite() && f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_992.0)
                .map(|f| f as i64)
        }),
        _ => None,
    }
}

fn lenient_i64<'de, D>(d: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = JsonValue::deserialize(d)?;
    json_i64(&v).ok_or_else(|| serde::de::Error::custom(format!("expected integer, got {v}")))
}

/// Decode a `{string: integer}` JSON map leniently (cursors, compactedThrough).
fn json_i64_map(v: &JsonValue) -> HashMap<String, i64> {
    v.as_object()
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| json_i64(v).map(|i| (k.clone(), i)))
                .collect()
        })
        .unwrap_or_default()
}

/// Decoded view of a plugin-db Y.Doc.
#[derive(Default)]
pub struct DocView {
    pub batches: Vec<Batch>,
    pub schema: Vec<String>,
    /// `meta.schemaVersion` (default 0 when absent). The client writes this
    /// alongside `meta.schema`; server-authored batches should mirror it.
    pub schema_version: i64,
    pub deleted_at: Option<i64>,
    /// Per-device applied cursors: device site -> { origin site -> db_version }.
    pub cursors: HashMap<String, HashMap<String, i64>>,
    /// When each device last refreshed its cursor (ms epoch).
    pub cursors_at: HashMap<String, i64>,
    pub compacted_through: HashMap<String, i64>,
}
/// A live plugin database the server holds a replica for.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDbInfo {
    pub plugin: String,
    pub name: String,
    pub updated_at: i64,
}

/// Result of a read-only `query_sql` call.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySqlResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<JsonValue>>,
    pub truncated: bool,
}

/// One write statement in an `execute_sql` batch.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteStatement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<JsonValue>,
}

/// Result of an `execute_sql` batch.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteSqlResult {
    pub rows_affected: u64,
    pub db_version: i64,
}

/// Cursor: origin site hex -> highest applied db_version.
type Cursor = HashMap<String, i64>;

// ---------- service ----------

struct DbState {
    dirty: bool,
    deadline: Instant,
    running: bool,
}

struct Inner {
    config: Arc<Config>,
    http: reqwest::Client,
    db: DatabaseConnection,
    authenticator: Arc<Authenticator>,
    dbs: Mutex<HashMap<String, DbState>>,
    /// Per-DB async write locks serializing server-authored write sequences
    /// (execute_sql, rollback_to_dump): fetch->refresh->write->publish->cursor.
    /// Replication (`replicate_once`) and read-only queries do NOT take these.
    write_locks: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// One-time probe result: the configured extension actually loads.
    ext_ok: std::sync::OnceLock<bool>,
}

#[derive(Clone)]
pub struct PluginDbService(Arc<Inner>);

impl PluginDbService {
    pub fn new(
        config: Arc<Config>,
        http: reqwest::Client,
        db: DatabaseConnection,
        authenticator: Arc<Authenticator>,
    ) -> Self {
        PluginDbService(Arc::new(Inner {
            config,
            http,
            db,
            authenticator,
            dbs: Mutex::new(HashMap::new()),
            write_locks: tokio::sync::Mutex::new(HashMap::new()),
            ext_ok: std::sync::OnceLock::new(),
        }))
    }

    fn debounce(&self) -> Duration {
        Duration::from_millis(self.0.config.git_debounce_ms)
    }

    /// Whether the cr-sqlite loadable extension is configured *and actually
    /// loads* (probed once, with a clear log line either way, so a wrong-arch
    /// or corrupt binary is obvious at startup instead of failing opaquely
    /// inside the git debounce).
    fn ext_available(&self) -> bool {
        *self.0.ext_ok.get_or_init(|| {
            let Some(path) = self.0.config.crsqlite_ext_path.as_ref() else {
                return false;
            };
            if !Path::new(path).exists() {
                tracing::warn!(
                    "crsqlite_ext_path {path} does not exist; \
                     plugin-db replication and git dumps are disabled"
                );
                return false;
            }
            match probe_extension(path) {
                Ok(site_hex) => {
                    tracing::info!(
                        "cr-sqlite extension loaded from {path} (probe site id {site_hex}); \
                         plugin-db replication enabled"
                    );
                    true
                }
                Err(e) => {
                    tracing::error!(
                        "cr-sqlite extension at {path} exists but failed to load \
                         (wrong architecture or corrupt download?): {e:#}; \
                         plugin-db replication and git dumps are disabled"
                    );
                    false
                }
            }
        })
    }

    fn doc_id(vault: &str, plugin: &str, name: &str) -> String {
        format!("{vault}__plugindb__{plugin}__{name}")
    }

    fn key(vault: &str, plugin: &str, name: &str) -> String {
        format!("{vault}\u{0}{plugin}\u{0}{name}")
    }
    /// Get (or insert) the per-DB async write lock. The caller locks the
    /// returned `Arc<Mutex<()>>` for the whole read-apply-write-publish
    /// sequence so concurrent server-authored writes to the same DB serialize.
    async fn write_lock(&self, vault: &str, plugin: &str, name: &str) -> Arc<tokio::sync::Mutex<()>> {
        let key = Self::key(vault, plugin, name);
        let mut locks = self.0.write_locks.lock().await;
        locks
            .entry(key)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// Record that a plugin database changed and (re)arm the replication debounce.
    pub async fn mark_write(&self, vault: &str, plugin: &str, name: &str) {
        let key = Self::key(vault, plugin, name);
        let mut dbs = self.0.dbs.lock().await;
        let entry = dbs.entry(key.clone()).or_insert_with(|| DbState {
            dirty: false,
            deadline: Instant::now(),
            running: false,
        });
        entry.dirty = true;
        entry.deadline = Instant::now() + self.debounce();
        if !entry.running {
            entry.running = true;
            let svc = self.clone();
            let vault = vault.to_string();
            let plugin = plugin.to_string();
            let name = name.to_string();
            tokio::spawn(async move { svc.run_db(vault, plugin, name).await });
        }
    }

    async fn run_db(self, vault: String, plugin: String, name: String) {
        let key = Self::key(&vault, &plugin, &name);
        loop {
            loop {
                let remaining = {
                    let dbs = self.0.dbs.lock().await;
                    match dbs.get(&key) {
                        Some(s) => s.deadline.checked_duration_since(Instant::now()),
                        None => return,
                    }
                };
                match remaining {
                    Some(d) => tokio::time::sleep(d).await,
                    None => break,
                }
            }
            {
                let mut dbs = self.0.dbs.lock().await;
                let Some(s) = dbs.get_mut(&key) else { return };
                if !s.dirty {
                    s.running = false;
                    return;
                }
                s.dirty = false;
            }
            if let Err(e) = self.replicate_once(&vault, &plugin, &name).await {
                tracing::warn!("plugin-db replicate {plugin}/{name} (vault {vault}) failed: {e:#}");
            }
            {
                let mut dbs = self.0.dbs.lock().await;
                let Some(s) = dbs.get_mut(&key) else { return };
                if !s.dirty {
                    s.running = false;
                    return;
                }
            }
        }
    }

    async fn fetch_doc(&self, doc_id: &str) -> Result<DocView> {
        let update = crate::ydoc::read_update_with(
            &self.0.config,
            &self.0.http,
            &self.0.authenticator,
            doc_id,
        )
        .await
        .map_err(|e| anyhow!(e.to_string()))?;
        decode_doc(&update)
    }

    /// Apply the doc's batches into the replica, then maybe compact the log.
    async fn replicate_once(&self, vault: &str, plugin: &str, name: &str) -> Result<()> {
        let view = self.fetch_doc(&Self::doc_id(vault, plugin, name)).await?;

        // Soft-deleted databases keep their replica; just stop replicating.
        if view.deleted_at.is_some() {
            return Ok(());
        }

        if self.ext_available() {
            let cursor = self.load_cursor(vault, plugin, name).await?;
            let config = self.0.config.clone();
            let (vault_s, plugin_s, name_s) =
                (vault.to_string(), plugin.to_string(), name.to_string());
            let schema = view.schema.clone();
            let batches = view.batches.clone();
            let new_cursor = tokio::task::spawn_blocking(move || {
                apply_to_replica(
                    &config, &vault_s, &plugin_s, &name_s, &schema, &batches, cursor,
                )
            })
            .await
            .context("replica task panicked")??;
            self.store_cursor(vault, plugin, name, &new_cursor).await?;
        }

        self.maybe_compact(vault, plugin, name, &view).await?;
        Ok(())
    }

    /// Serve a bootstrap changeset. Prefers the on-disk replica (which retains
    /// everything ever applied, surviving Y-log compaction); falls back to the
    /// Y.Doc batch log when the loadable extension is unavailable. If the log
    /// was compacted and no replica exists, this errors rather than silently
    /// returning an incomplete changeset.
    pub async fn bootstrap_changes(
        &self,
        vault: &str,
        plugin: &str,
        name: &str,
        since: &Cursor,
    ) -> Result<Vec<ChangeRow>> {
        let view = self.fetch_doc(&Self::doc_id(vault, plugin, name)).await?;

        if self.ext_available() {
            // Bring the replica current first, then read the full changeset
            // from it (the replica is the compaction authority's source of truth).
            let cursor = self.load_cursor(vault, plugin, name).await?;
            let config = self.0.config.clone();
            let (vault_s, plugin_s, name_s) =
                (vault.to_string(), plugin.to_string(), name.to_string());
            let schema = view.schema.clone();
            let batches = view.batches.clone();
            let since_c = since.clone();
            let res = tokio::task::spawn_blocking(move || -> Result<(Cursor, Vec<ChangeRow>)> {
                let new_cursor = apply_to_replica(
                    &config, &vault_s, &plugin_s, &name_s, &schema, &batches, cursor,
                )?;
                let rows = read_replica_changes(&config, &vault_s, &plugin_s, &name_s, &since_c)?;
                Ok((new_cursor, rows))
            })
            .await
            .context("bootstrap task panicked")?;
            match res {
                Ok((new_cursor, rows)) => {
                    self.store_cursor(vault, plugin, name, &new_cursor).await?;
                    return Ok(rows);
                }
                Err(e) => {
                    tracing::warn!(
                        "replica bootstrap for {plugin}/{name} (vault {vault}) failed, \
                         falling back to the doc log: {e:#}"
                    );
                }
            }
        }

        // Doc-log fallback: only complete while nothing has been compacted away.
        if !view.compacted_through.is_empty() {
            return Err(anyhow!(
                "batch log was compacted and the server replica is unavailable; \
                 cannot serve a complete bootstrap"
            ));
        }
        let mut out = Vec::new();
        for batch in &view.batches {
            let floor = since.get(&batch.site_id).copied().unwrap_or(0);
            if batch.to_db_version <= floor {
                continue;
            }
            for c in &batch.changes {
                if c.db_version > floor {
                    out.push(c.clone());
                }
            }
        }
        out.sort_by(|a, b| {
            a.site_id
                .cmp(&b.site_id)
                .then(a.db_version.cmp(&b.db_version))
                .then(a.seq.cmp(&b.seq))
        });
        Ok(out)
    }

    /// Purge: delete the replica file, mark the DB tombstoned, and trim the Y.Doc.
    pub async fn purge(&self, vault: &str, plugin: &str, name: &str) -> Result<()> {
        // Mark deleted in the server DB so git stops dumping it.
        self.mark_deleted_row(vault, plugin, name).await?;

        // Remove the replica file.
        let path = replica_path(&self.0.config, vault, plugin, name);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }

        // Trim the Y.Doc: clear batches and set the tombstone.
        let doc_id = Self::doc_id(vault, plugin, name);
        if let Ok(update) = crate::ydoc::read_update_with(
            &self.0.config,
            &self.0.http,
            &self.0.authenticator,
            &doc_id,
        )
        .await
        {
            if let Ok(trim) = build_purge_update(&update) {
                if !trim.is_empty() {
                    let _ = self.write_doc(&doc_id, trim).await;
                }
            }
        }
        Ok(())
    }

    async fn write_doc(&self, doc_id: &str, update: Vec<u8>) -> Result<()> {
        let (base_url, token) = crate::ysweet::mint_internal_token_with(
            &self.0.config,
            &self.0.http,
            &self.0.authenticator,
            doc_id,
            crate::ysweet::Level::Full,
        )
        .await
        .map_err(|e| anyhow!(e.to_string()))?;
        let url = format!("{}/update", base_url.trim_end_matches('/'));
        let res = self
            .0
            .http
            .post(&url)
            .bearer_auth(token)
            .body(update)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(anyhow!("update {doc_id} returned {}", res.status()));
        }
        Ok(())
    }

    /// Compact the Y.Doc log when every live consumer has applied past a batch.
    async fn maybe_compact(
        &self,
        vault: &str,
        plugin: &str,
        name: &str,
        view: &DocView,
    ) -> Result<()> {
        // Safe high-water mark per origin site: the minimum applied db_version
        // across all non-stale device cursors, intersected with the server's own
        // replica cursor.
        let server_cursor = self
            .load_cursor(vault, plugin, name)
            .await
            .unwrap_or_default();
        let mut safe: Cursor = HashMap::new();

        // Collect origin sites from batches.
        let mut sites: Vec<String> = view.batches.iter().map(|b| b.site_id.clone()).collect();
        sites.sort();
        sites.dedup();

        let now = now_millis();
        for site in &sites {
            let mut min_v = server_cursor.get(site).copied().unwrap_or(0);
            let mut any = self.ext_available(); // only trust server cursor if we replicate
            for (device, device_cursor) in &view.cursors {
                // A device trivially covers the changes it produced itself; its
                // cursor only tracks *remote* origin sites.
                if device == site {
                    continue;
                }
                // Ignore devices whose cursor has not been refreshed within the
                // staleness window (lost/abandoned devices must not hold back
                // compaction forever). A device without a timestamp is treated
                // as live — conservative for docs written by older clients.
                let stale = view
                    .cursors_at
                    .get(device)
                    .map(|t| now.saturating_sub(*t) > STALE_CURSOR_MS)
                    .unwrap_or(false);
                if stale {
                    continue;
                }
                let v = device_cursor.get(site).copied().unwrap_or(0);
                min_v = min_v.min(v);
                any = true;
            }
            if any {
                safe.insert(site.clone(), min_v);
            }
        }

        // Determine which batches are fully covered and can be dropped.
        let drop_count = view
            .batches
            .iter()
            .take_while(|b| safe.get(&b.site_id).copied().unwrap_or(0) >= b.to_db_version)
            .count();
        if drop_count == 0 {
            return Ok(());
        }

        let doc_id = Self::doc_id(vault, plugin, name);
        let update = crate::ydoc::read_update_with(
            &self.0.config,
            &self.0.http,
            &self.0.authenticator,
            &doc_id,
        )
        .await
        .map_err(|e| anyhow!(e.to_string()))?;
        if let Ok(trim) = build_compaction_update(&update, drop_count, &safe) {
            if !trim.is_empty() {
                let _ = self.write_doc(&doc_id, trim).await;
            }
        }
        Ok(())
    }

    // ---- server cursor persistence ----

    async fn load_cursor(&self, vault: &str, plugin: &str, name: &str) -> Result<Cursor> {
        let row = self.find_row(vault, plugin, name).await?;
        Ok(row
            .and_then(|r| serde_json::from_str::<Cursor>(&r.cursor_json).ok())
            .unwrap_or_default())
    }

    async fn store_cursor(
        &self,
        vault: &str,
        plugin: &str,
        name: &str,
        cursor: &Cursor,
    ) -> Result<()> {
        let json = serde_json::to_string(cursor).unwrap_or_else(|_| "{}".to_string());
        let existing = self.find_row(vault, plugin, name).await?;
        if let Some(model) = existing {
            let mut active: plugin_db_replicas::ActiveModel = model.into();
            active.cursor_json = Set(json);
            active.updated_at = Set(now_millis());
            active.update(&self.0.db).await?;
        } else {
            plugin_db_replicas::ActiveModel {
                id: Set(uuid::Uuid::new_v4().to_string()),
                vault_id: Set(vault.to_string()),
                plugin_id: Set(plugin.to_string()),
                name: Set(name.to_string()),
                cursor_json: Set(json),
                deleted: Set(false),
                updated_at: Set(now_millis()),
            }
            .insert(&self.0.db)
            .await?;
        }
        Ok(())
    }

    async fn mark_deleted_row(&self, vault: &str, plugin: &str, name: &str) -> Result<()> {
        if let Some(model) = self.find_row(vault, plugin, name).await? {
            let mut active: plugin_db_replicas::ActiveModel = model.into();
            active.deleted = Set(true);
            active.updated_at = Set(now_millis());
            active.update(&self.0.db).await?;
        }
        Ok(())
    }

    async fn find_row(
        &self,
        vault: &str,
        plugin: &str,
        name: &str,
    ) -> Result<Option<plugin_db_replicas::Model>> {
        Ok(plugin_db_replicas::Entity::find()
            .filter(plugin_db_replicas::Column::VaultId.eq(vault))
            .filter(plugin_db_replicas::Column::PluginId.eq(plugin))
            .filter(plugin_db_replicas::Column::Name.eq(name))
            .one(&self.0.db)
            .await?)
    }

    /// Whether a rollback to `target_sql` is currently possible:
    /// `(rollbackable, reason-when-not)`. Requires the extension, an existing
    /// replica, and a dump whose table schema matches the replica's.
    pub async fn rollback_check(
        &self,
        vault: &str,
        plugin: &str,
        name: &str,
        target_sql: &str,
    ) -> (bool, Option<String>) {
        if !self.ext_available() {
            return (false, Some("cr-sqlite extension unavailable".into()));
        }
        let path = replica_path(&self.0.config, vault, plugin, name);
        if !path.exists() {
            return (false, Some("no server replica for this database".into()));
        }
        let config = self.0.config.clone();
        let (vault, plugin, name, sql) = (
            vault.to_string(),
            plugin.to_string(),
            name.to_string(),
            target_sql.to_string(),
        );
        let res = tokio::task::spawn_blocking(move || {
            schema_matches(&config, &vault, &plugin, &name, &sql)
        })
        .await;
        match res {
            Ok(Ok(true)) => (true, None),
            Ok(Ok(false)) => (false, Some("dump schema differs from the replica".into())),
            Ok(Err(e)) => (false, Some(format!("schema check failed: {e:#}"))),
            Err(_) => (false, Some("schema check task panicked".into())),
        }
    }

    /// Roll the replica back to `target_sql` (a dump previously produced by
    /// [`dump_replica`]) and publish the resulting cr-sqlite changes as a
    /// server-authored batch appended to the database's Y.Doc log, so every
    /// client converges on the dumped state like any peer's edit.
    pub async fn rollback_to_dump(
        &self,
        vault: &str,
        plugin: &str,
        name: &str,
        target_sql: &str,
    ) -> Result<()> {
        if !self.ext_available() {
            return Err(anyhow!("cr-sqlite extension unavailable"));
        }
        // Serialize against any other server-authored write to this DB
        // (execute_sql, or a concurrent rollback). The blocking replica edit,
        // the doc append, and the cursor advance form one atomic publish unit.
        let lock = self.write_lock(vault, plugin, name).await;
        let _guard = lock.lock().await;
        let config = self.0.config.clone();
        let (vault_s, plugin_s, name_s, sql) = (
            vault.to_string(),
            plugin.to_string(),
            name.to_string(),
            target_sql.to_string(),
        );
        let (rows, site_hex, site_b64, post) = tokio::task::spawn_blocking(move || {
            apply_dump_rollback(&config, &vault_s, &plugin_s, &name_s, &sql)
        })
        .await
        .context("rollback task panicked")??;

        if rows.is_empty() {
            return Ok(());
        }

        self.publish_own_batch(vault, plugin, name, rows, site_hex, site_b64, post)
            .await
    }
    /// Append a server-authored batch (already-computed own-site cr-sqlite
    /// changes) to the database's Y.Doc log and advance the stored server
    /// cursor past its own site so replication doesn't re-apply it.
    ///
    /// Shared by [`rollback_to_dump`] and [`execute_sql`]. The caller MUST hold
    /// the per-DB write lock so the replica write, the doc fetch, and the
    /// cursor advance observe a consistent state.
    async fn publish_own_batch(
        &self,
        vault: &str,
        plugin: &str,
        name: &str,
        rows: Vec<ChangeRow>,
        site_hex: String,
        site_b64: String,
        post: i64,
    ) -> Result<()> {
        let doc_id = Self::doc_id(vault, plugin, name);
        let view = self.fetch_doc(&doc_id).await.unwrap_or_default();
        // Prefer the doc-level schemaVersion (decoded from meta); fall back to
        // the last batch's value, then 1, matching the pre-refactor behavior.
        let schema_version = if view.schema_version != 0 {
            view.schema_version
        } else {
            view.batches.last().map(|b| b.schema_version).unwrap_or(1)
        };
        let format = view
            .batches
            .last()
            .map(|b| b.format.clone())
            .filter(|f| !f.is_empty())
            .unwrap_or_else(|| crate::caps::PLUGIN_DB_SYNC.to_string());
        let from = rows.iter().map(|r| r.db_version).min().unwrap_or(post) - 1;
        let batch = serde_json::json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "siteId": site_b64,
            "fromDbVersion": from,
            "toDbVersion": post,
            "schemaVersion": schema_version,
            "changes": serde_json::to_value(&rows)?,
            "format": format,
        });
        let current = crate::ydoc::read_update_with(
            &self.0.config,
            &self.0.http,
            &self.0.authenticator,
            &doc_id,
        )
        .await
        .map_err(|e| anyhow!(e.to_string()))?;
        let update = build_append_batch_update(&current, &batch)?;
        if !update.is_empty() {
            self.write_doc(&doc_id, update).await?;
        }

        // Advance the stored server cursor past its own site so replication
        // doesn't re-apply the batch we just produced from the replica.
        let mut cursor = self.load_cursor(vault, plugin, name).await?;
        let entry = cursor.entry(site_hex).or_insert(0);
        *entry = (*entry).max(post);
        self.store_cursor(vault, plugin, name, &cursor).await?;
        Ok(())
    }

    /// Deterministic SQL dumps for a vault's live plugin databases, for git.
    /// Returns `(relative_path, sql)` pairs. Empty when the extension is absent.
    pub async fn dumps_for_vault(&self, vault: &str) -> Vec<(PathBuf, String)> {
        if !self.ext_available() {
            return Vec::new();
        }
        let rows = match plugin_db_replicas::Entity::find()
            .filter(plugin_db_replicas::Column::VaultId.eq(vault))
            .filter(plugin_db_replicas::Column::Deleted.eq(false))
            .all(&self.0.db)
            .await
        {
            Ok(rows) => rows,
            Err(_) => return Vec::new(),
        };

        let mut out = Vec::new();
        for row in rows {
            let config = self.0.config.clone();
            let (vault_s, plugin_s, name_s) =
                (vault.to_string(), row.plugin_id.clone(), row.name.clone());
            let dump = tokio::task::spawn_blocking(move || {
                dump_replica(&config, &vault_s, &plugin_s, &name_s)
            })
            .await;
            if let Ok(Ok(Some(sql))) = dump {
                let rel = PathBuf::from(crate::git::SQL_DUMP_DIR)
                    .join(&row.plugin_id)
                    .join(format!("{}.sql", row.name));
                out.push((rel, sql));
            }
        }
        out
    }
    /// List the plugin databases the server holds a replica for in `vault`.
    /// Rows appear once the server has replicated a database at least once;
    /// that is exactly the set the server can serve SQL for. An empty vault
    /// yields an empty vec, not an error.
    pub async fn list_dbs(&self, vault: &str) -> Result<Vec<PluginDbInfo>> {
        let rows = plugin_db_replicas::Entity::find()
            .filter(plugin_db_replicas::Column::VaultId.eq(vault))
            .filter(plugin_db_replicas::Column::Deleted.eq(false))
            .all(&self.0.db)
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| PluginDbInfo {
                plugin: r.plugin_id,
                name: r.name,
                updated_at: r.updated_at,
            })
            .collect())
    }

    /// Run a read-only SELECT against the server replica. `limit` is clamped to
    /// `[1, 5000]` (default 500). Requires the cr-sqlite extension; the
    /// replica is refreshed from the doc before reading so client writes
    /// visible in the Y.Doc are reflected.
    pub async fn query_sql(
        &self,
        vault: &str,
        plugin: &str,
        name: &str,
        sql: &str,
        params: &[JsonValue],
        limit: Option<usize>,
    ) -> std::result::Result<QuerySqlResult, crate::error::AppError> {
        use crate::error::AppError;
        if !self.ext_available() {
            return Err(AppError::BadRequest(
                "cr-sqlite extension unavailable on this server; plugin-db SQL is disabled".into(),
            ));
        }
        if let Err(msg) = lint_sql(sql) {
            return Err(AppError::BadRequest(msg));
        }
        if !is_read_statement(sql) {
            return Err(AppError::BadRequest(
                "query endpoint accepts only SELECT or WITH statements; \
                 statement must start with SELECT or WITH"
                    .into(),
            ));
        }
        let doc_id = Self::doc_id(vault, plugin, name);
        let view = self
            .fetch_doc(&doc_id)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
        if view.deleted_at.is_some() {
            return Err(AppError::BadRequest("database is deleted".into()));
        }
        let replica = replica_path(&self.0.config, vault, plugin, name);
        // Existence: the DB must have been created by a plugin client first
        // (schema in the doc, or a replica file already materialized).
        if view.schema.is_empty() && view.batches.is_empty() && !replica.exists() {
            return Err(AppError::NotFound);
        }
        // Refresh the replica so reads see all client writes the doc has.
        let cursor = self.load_cursor(vault, plugin, name).await.map_err(|e| {
            AppError::Internal(format!("load cursor: {e:#}"))
        })?;
        let config = self.0.config.clone();
        let (vault_s, plugin_s, name_s, schema_s, batches_s) = (
            vault.to_string(),
            plugin.to_string(),
            name.to_string(),
            view.schema.clone(),
            view.batches.clone(),
        );
        let new_cursor = tokio::task::spawn_blocking(move || {
            apply_to_replica(
                &config, &vault_s, &plugin_s, &name_s, &schema_s, &batches_s, cursor,
            )
        })
        .await
        .map_err(|e| AppError::Internal(format!("replica refresh task panicked: {e}")))?
        .map_err(|e| AppError::Internal(format!("replica refresh: {e:#}")))?;
        self.store_cursor(vault, plugin, name, &new_cursor)
            .await
            .map_err(|e| AppError::Internal(format!("store cursor: {e:#}")))?;

        let limit = limit.unwrap_or(500).clamp(1, 5000);
        let path = replica_path(&self.0.config, vault, plugin, name);
        let sql = sql.to_string();
        let params = params.to_vec();
        let res = tokio::task::spawn_blocking(move || -> std::result::Result<QuerySqlResult, String> {
            // Plain SQLite + query_only: SELECT-only guaranteed at theConnection
            // level too, so a misclassified statement cannot mutate the replica.
            let conn = Connection::open(&path).map_err(|e| e.to_string())?;
            conn.busy_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?;
            conn.pragma_update(None, "query_only", true).map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let columns = stmt
                .column_names()
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>();
            let sql_params: Vec<SqlValue> = params.iter().map(json_to_sql).collect();
            let param_refs: Vec<&SqlValue> = sql_params.iter().collect();
            let mut rows = stmt
                .query(rusqlite::params_from_iter(param_refs))
                .map_err(|e| e.to_string())?;
            let mut out: Vec<Vec<JsonValue>> = Vec::new();
            let mut truncated = false;
            let mut count = 0usize;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                if count >= limit {
                    truncated = true;
                    break;
                }
                let n = row.as_ref().column_count();
                let mut vals = Vec::with_capacity(n);
                for i in 0..n {
                    let v: SqlValue = row.get(i).map_err(|e| e.to_string())?;
                    vals.push(sql_to_json(&v));
                }
                out.push(vals);
                count += 1;
            }
            std::result::Result::Ok(QuerySqlResult { columns, rows: out, truncated })
        })
        .await
        .map_err(|e| AppError::Internal(format!("query task panicked: {e}")))?;
        res.map_err(|e| AppError::BadRequest(e))
    }

    /// Run write statements (INSERT/UPDATE/DELETE/REPLACE) in one transaction
    /// against the server replica, then publish the resulting cr-sqlite
    /// changes as a server-authored batch so all clients converge (CRDT
    /// last-writer-wins). Schema changes are not allowed — the schema is
    /// owned by plugin `migrate()` on clients.
    pub async fn execute_sql(
        &self,
        vault: &str,
        plugin: &str,
        name: &str,
        statements: &[ExecuteStatement],
    ) -> std::result::Result<ExecuteSqlResult, crate::error::AppError> {
        use crate::error::AppError;
        if !self.ext_available() {
            return Err(AppError::BadRequest(
                "cr-sqlite extension unavailable on this server; plugin-db SQL is disabled".into(),
            ));
        }
        if statements.is_empty() {
            return Err(AppError::BadRequest("statements must not be empty".into()));
        }
        if statements.len() > 100 {
            return Err(AppError::BadRequest("at most 100 statements per call".into()));
        }
        for s in statements {
            if let Err(msg) = lint_sql(&s.sql) {
                return Err(AppError::BadRequest(msg));
            }
            if !is_write_statement(&s.sql) {
                return Err(AppError::BadRequest(
                    "execute endpoint accepts only INSERT/UPDATE/DELETE/REPLACE; \
                     statement must start with one of those keywords"
                        .into(),
                ));
            }
        }

        // Serialize the whole read-apply-write-publish-cursor sequence against
        // other server-authored writes to this DB. LWW clocks must be current
        // before writing, or concurrent client edits would lose to stale
        // server writes; the locked span covers fetch→refresh→execute→publish.
        let lock = self.write_lock(vault, plugin, name).await;
        let _guard = lock.lock().await;

        let doc_id = Self::doc_id(vault, plugin, name);
        let view = self
            .fetch_doc(&doc_id)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
        if view.deleted_at.is_some() {
            return Err(AppError::BadRequest("database is deleted".into()));
        }
        let replica = replica_path(&self.0.config, vault, plugin, name);
        if view.schema.is_empty() && view.batches.is_empty() && !replica.exists() {
            return Err(AppError::NotFound);
        }

        // Refresh the replica so the upcoming writes merge on top of the
        // latest client state (otherwise stale server writes would clobber
        // concurrent client edits under LWW).
        let cursor = self.load_cursor(vault, plugin, name).await.map_err(|e| {
            AppError::Internal(format!("load cursor: {e:#}"))
        })?;
        let config = self.0.config.clone();
        let (vault_s, plugin_s, name_s, schema_s, batches_s) = (
            vault.to_string(),
            plugin.to_string(),
            name.to_string(),
            view.schema.clone(),
            view.batches.clone(),
        );
        let new_cursor = tokio::task::spawn_blocking(move || {
            apply_to_replica(
                &config, &vault_s, &plugin_s, &name_s, &schema_s, &batches_s, cursor,
            )
        })
        .await
        .map_err(|e| AppError::Internal(format!("replica refresh task panicked: {e}")))?
        .map_err(|e| AppError::Internal(format!("replica refresh: {e:#}")))?;
        self.store_cursor(vault, plugin, name, &new_cursor)
            .await
            .map_err(|e| AppError::Internal(format!("store cursor: {e:#}")))?;

        // Execute the batch against the replica (extension loaded), in one
        // transaction. Returns own-site cr-sqlite change rows past `pre`.
        let config = self.0.config.clone();
        let (vault_s, plugin_s, name_s) = (vault.to_string(), plugin.to_string(), name.to_string());
        let stmts_owned: Vec<(String, Vec<JsonValue>)> = statements
            .iter()
            .map(|s| (s.sql.clone(), s.params.clone()))
            .collect();
        let exec_res = tokio::task::spawn_blocking(move || {
            execute_against_replica(&config, &vault_s, &plugin_s, &name_s, &stmts_owned)
        })
        .await
        .map_err(|e| AppError::Internal(format!("execute task panicked: {e}")))?
        .map_err(|e| AppError::BadRequest(e.to_string()))?;
        let (rows_affected, rows, site_hex, site_b64, post) = exec_res;

        if rows.is_empty() {
            // All statements were no-ops (no cr-sqlite change rows). The
            // replica is already current; nothing to publish.
            return std::result::Result::Ok(ExecuteSqlResult {
                rows_affected,
                db_version: post,
            });
        }

        // Publish the batch to the Y.Doc log and advance the server cursor.
        // A failure here after the replica commit is returned as Internal:
        // the replica has the write but clients see it only after a successful
        // publish. The caller may retry the same statements (idempotent for
        // LWW upserts); the next replication/compaction pass will not
        // re-publish own-site rows (they are invisible to apply_to_replica).
        if let Err(e) = self
            .publish_own_batch(vault, plugin, name, rows, site_hex, site_b64, post)
            .await
        {
            tracing::error!(
                "execute_sql publish failed for {plugin}/{name} (vault {vault}) \
                 after replica commit: {e:#}; clients will see the write on retry"
            );
            return Err(AppError::Internal(format!(
                "write committed to replica but publish to clients failed: {e:#}"
            )));
        }
        std::result::Result::Ok(ExecuteSqlResult {
            rows_affected,
            db_version: post,
        })
    }
}

/// Parse a `{vault}__plugindb__{plugin}__{name}` doc id. Unambiguous because
/// plugin ids / names are validated to never contain `__`.
pub fn parse_doc_id(doc_id: &str) -> Option<(String, String, String)> {
    let mut parts = doc_id.split("__");
    let vault = parts.next()?;
    if parts.next()? != "plugindb" {
        return None;
    }
    let plugin = parts.next()?;
    let name = parts.next()?;
    if vault.is_empty() || plugin.is_empty() || name.is_empty() || parts.next().is_some() {
        return None;
    }
    Some((vault.to_string(), plugin.to_string(), name.to_string()))
}

// ---------- Y.Doc decode / trim ----------

fn doc_from_update(update: &[u8]) -> Result<Doc> {
    let doc = Doc::new();
    let upd = Update::decode_v1(update).map_err(|e| anyhow!("decode update: {e:?}"))?;
    doc.transact_mut().apply_update(upd);
    Ok(doc)
}

pub fn decode_doc(update: &[u8]) -> Result<DocView> {
    let doc = doc_from_update(update)?;
    let batches_arr = doc.get_or_insert_array("batches");
    let meta = doc.get_or_insert_map("meta");
    let cursors = doc.get_or_insert_map("cursors");
    let cursors_at = doc.get_or_insert_map("cursorsAt");
    let txn = doc.transact();

    let batches_json = any_to_json(&batches_arr.to_json(&txn));
    let batches: Vec<Batch> = match serde_json::from_value(batches_json) {
        Ok(b) => b,
        Err(e) => {
            // A decode failure here means wire-format drift — do not silently
            // treat the log as empty (that disabled replication entirely).
            tracing::warn!("failed to decode plugin-db batches (wire-format drift?): {e}");
            return Err(anyhow!("failed to decode plugin-db batches: {e}"));
        }
    };

    let meta_json = any_to_json(&meta.to_json(&txn));
    let schema: Vec<String> = meta_json
        .get("schema")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let deleted_at = meta_json.get("deletedAt").and_then(json_i64);
    let schema_version = meta_json.get("schemaVersion").and_then(json_i64).unwrap_or(0);
    let compacted_through: HashMap<String, i64> = meta_json
        .get("compactedThrough")
        .map(json_i64_map)
        .unwrap_or_default();

    let cursors_json = any_to_json(&cursors.to_json(&txn));
    let cursors: HashMap<String, HashMap<String, i64>> = cursors_json
        .as_object()
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.clone(), json_i64_map(v)))
                .collect()
        })
        .unwrap_or_default();

    let cursors_at_json = any_to_json(&cursors_at.to_json(&txn));
    let cursors_at: HashMap<String, i64> = json_i64_map(&cursors_at_json);

    Ok(DocView {
        batches,
        schema,
        schema_version,
        deleted_at,
        cursors,
        cursors_at,
        compacted_through,
    })
}

/// Build an update that clears `batches` and sets `meta.deletedAt` (purge).
fn build_purge_update(current: &[u8]) -> Result<Vec<u8>> {
    let doc = doc_from_update(current)?;
    let before = doc.transact().state_vector();
    let batches = doc.get_or_insert_array("batches");
    let meta = doc.get_or_insert_map("meta");
    {
        let mut txn = doc.transact_mut();
        let len = batches.len(&txn);
        if len > 0 {
            batches.remove_range(&mut txn, 0, len);
        }
        meta.insert(&mut txn, "deletedAt".to_string(), Any::BigInt(now_millis()));
    }
    let update = doc.transact().encode_state_as_update_v1(&before);
    Ok(update)
}

/// Build an update that drops the first `drop_count` batches and records the
/// new `compactedThrough` high-water marks.
fn build_compaction_update(current: &[u8], drop_count: usize, safe: &Cursor) -> Result<Vec<u8>> {
    let doc = doc_from_update(current)?;
    let before = doc.transact().state_vector();
    let batches = doc.get_or_insert_array("batches");
    let meta = doc.get_or_insert_map("meta");
    {
        let mut txn = doc.transact_mut();
        let len = batches.len(&txn) as usize;
        let n = drop_count.min(len) as u32;
        if n > 0 {
            batches.remove_range(&mut txn, 0, n);
        }
        let map: HashMap<String, Any> = safe
            .iter()
            .map(|(k, v)| (k.clone(), Any::BigInt(*v)))
            .collect();
        meta.insert(
            &mut txn,
            "compactedThrough".to_string(),
            Any::Map(map.into()),
        );
    }
    let update = doc.transact().encode_state_as_update_v1(&before);
    Ok(update)
}

/// Build an update appending one batch (JSON-shaped) to the `batches` array.
/// Append-at-end is safe versus concurrent compaction (which trims the front).
fn build_append_batch_update(current: &[u8], batch: &JsonValue) -> Result<Vec<u8>> {
    let doc = doc_from_update(current)?;
    let before = doc.transact().state_vector();
    let batches = doc.get_or_insert_array("batches");
    {
        let mut txn = doc.transact_mut();
        let len = batches.len(&txn);
        batches.insert(&mut txn, len, crate::ydoc::json_to_any(batch));
    }
    let update = doc.transact().encode_state_as_update_v1(&before);
    Ok(update)
}

// ---------- dump-based rollback (blocking side) ----------

/// The `-- crr: t1,t2` trailer of a dump.
fn dump_crr_tables(dump: &str) -> Vec<String> {
    dump.lines()
        .rev()
        .find_map(|l| l.strip_prefix("-- crr: "))
        .map(|list| {
            list.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Normalize CREATE TABLE SQL for comparison (whitespace-insensitive).
fn normalize_sql(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// CREATE TABLE statements in a dump, keyed by an opaque normalized form.
fn dump_create_statements(dump: &str) -> Vec<String> {
    let mut out = Vec::new();
    for stmt in dump.split(";\n") {
        let trimmed = stmt.trim_start();
        if trimmed
            .get(..12)
            .map(|s| s.eq_ignore_ascii_case("CREATE TABLE"))
            .unwrap_or(false)
        {
            out.push(normalize_sql(trimmed));
        }
    }
    out.sort();
    out
}

/// Whether the dump's user-table schema matches the replica's.
fn schema_matches(
    config: &Config,
    vault: &str,
    plugin: &str,
    name: &str,
    dump: &str,
) -> Result<bool> {
    let path = replica_path(config, vault, plugin, name);
    let (conn, _is_new) = open_replica(config, &path)?;
    let mut replica_creates = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' \
             AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'crsql_%' \
             AND name NOT LIKE '%__crsql_clock' AND name NOT LIKE '%__crsql_pks' \
             ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for r in rows {
            replica_creates.push(normalize_sql(&r?));
        }
    }
    let _ = conn.query_row("SELECT crsql_finalize()", [], |_| Ok(()));
    replica_creates.sort();
    Ok(replica_creates == dump_create_statements(dump))
}

/// Diff the replica's CRR tables against a materialized dump and apply the
/// difference in one transaction, returning the resulting own-site changes
/// `(rows, site_hex, site_b64, post_db_version)`.
fn apply_dump_rollback(
    config: &Config,
    vault: &str,
    plugin: &str,
    name: &str,
    dump: &str,
) -> Result<(Vec<ChangeRow>, String, String, i64)> {
    if !schema_matches(config, vault, plugin, name, dump)? {
        return Err(anyhow!("dump schema differs from the replica"));
    }
    let path = replica_path(config, vault, plugin, name);
    if !path.exists() {
        return Err(anyhow!("no server replica for this database"));
    }
    let (mut conn, _is_new) = open_replica(config, &path)?;

    // Materialize the dump into a plain temporary database.
    let temp = Connection::open_in_memory()?;
    temp.execute_batch(dump).context("materialize dump")?;
    let crr = dump_crr_tables(dump);

    let pre: i64 = conn.query_row("SELECT crsql_db_version()", [], |row| row.get(0))?;
    let site_bytes: Vec<u8> = conn.query_row("SELECT crsql_site_id()", [], |row| row.get(0))?;
    let site_hex = bytes_to_hex(&site_bytes);
    let site_b64 = bytes_to_b64(&site_bytes);

    let tx = conn.transaction()?;
    for table in &crr {
        diff_apply_table(&tx, &temp, table)?;
    }
    tx.commit()?;

    let post: i64 = conn.query_row("SELECT crsql_db_version()", [], |row| row.get(0))?;

    // Collect the changes this rollback produced (our own site, past `pre`).
    let mut rows = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT \"table\", pk, cid, val, col_version, db_version, site_id, cl, seq \
             FROM crsql_changes \
             WHERE db_version > ?1 AND site_id = crsql_site_id() \
             ORDER BY db_version, seq",
        )?;
        let mapped = stmt.query_map([pre], |row| {
            let pk: Vec<u8> = row.get(1)?;
            let val: SqlValue = row.get(3)?;
            let site: Vec<u8> = row.get(6)?;
            Ok(ChangeRow {
                table: row.get(0)?,
                pk: bytes_to_b64(&pk),
                cid: row.get(2)?,
                val: sql_to_json(&val),
                col_version: row.get(4)?,
                db_version: row.get(5)?,
                site_id: bytes_to_b64(&site),
                cl: row.get(7)?,
                seq: row.get(8)?,
            })
        })?;
        for r in mapped {
            rows.push(r?);
        }
    }
    let _ = conn.query_row("SELECT crsql_finalize()", [], |_| Ok(()));
    Ok((rows, site_hex, site_b64, post))
}
/// Execute a batch of write statements against the replica in one transaction,
/// returning `(rows_affected, own_site_change_rows, site_hex, site_b64, post_db_version)`.
///
/// The extension is loaded via `open_replica`. `rusqlite`'s `execute` rejects
/// statements that return rows (e.g. `INSERT … RETURNING`) and any SQL with
/// trailing content after the first statement (`Error::MultipleStatement`), so
/// the caller's `is_write_statement` / `lint_sql` guards plus this keep the
/// replica schema-owned and single-statement-per-row.
fn execute_against_replica(
    config: &Config,
    vault: &str,
    plugin: &str,
    name: &str,
    statements: &[(String, Vec<JsonValue>)],
) -> Result<(u64, Vec<ChangeRow>, String, String, i64)> {
    let path = replica_path(config, vault, plugin, name);
    if !path.exists() {
        return Err(anyhow!("no server replica for this database"));
    }
    let (mut conn, _is_new) = open_replica(config, &path)?;
    let pre: i64 = conn.query_row("SELECT crsql_db_version()", [], |row| row.get(0))?;
    let site_bytes: Vec<u8> = conn.query_row("SELECT crsql_site_id()", [], |row| row.get(0))?;
    let site_hex = bytes_to_hex(&site_bytes);
    let site_b64 = bytes_to_b64(&site_bytes);

    let mut rows_affected: u64 = 0;
    let tx = conn.transaction()?;
    {
        for (sql, params) in statements {
            let sql_params: Vec<SqlValue> = params.iter().map(json_to_sql).collect();
            let param_refs: Vec<&SqlValue> = sql_params.iter().collect();
            rows_affected += tx.execute(sql, rusqlite::params_from_iter(param_refs))? as u64;
        }
    }
    tx.commit()?;

    let post: i64 = conn.query_row("SELECT crsql_db_version()", [], |row| row.get(0))?;

    // Collect this site's own changes past `pre` (same readback as rollback).
    let mut rows = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT \"table\", pk, cid, val, col_version, db_version, site_id, cl, seq \
             FROM crsql_changes \
             WHERE db_version > ?1 AND site_id = crsql_site_id() \
             ORDER BY db_version, seq",
        )?;
        let mapped = stmt.query_map([pre], |row| {
            let pk: Vec<u8> = row.get(1)?;
            let val: SqlValue = row.get(3)?;
            let site: Vec<u8> = row.get(6)?;
            Ok(ChangeRow {
                table: row.get(0)?,
                pk: bytes_to_b64(&pk),
                cid: row.get(2)?,
                val: sql_to_json(&val),
                col_version: row.get(4)?,
                db_version: row.get(5)?,
                site_id: bytes_to_b64(&site),
                cl: row.get(7)?,
                seq: row.get(8)?,
            })
        })?;
        for r in mapped {
            rows.push(r?);
        }
    }
    let _ = conn.query_row("SELECT crsql_finalize()", [], |_| Ok(()));
    Ok((rows_affected, rows, site_hex, site_b64, post))
}

/// Table column metadata: `(all_columns, pk_columns)` in declared order.
fn table_columns(conn: &Connection, table: &str) -> Result<(Vec<String>, Vec<String>)> {
    let table = table.replace('"', "");
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
    })?;
    let mut cols = Vec::new();
    let mut pks: Vec<(i64, String)> = Vec::new();
    for r in rows {
        let (name, pk) = r?;
        if pk > 0 {
            pks.push((pk, name.clone()));
        }
        cols.push(name);
    }
    pks.sort();
    Ok((cols, pks.into_iter().map(|(_, n)| n).collect()))
}

fn read_table_rows(
    conn: &Connection,
    table: &str,
    cols: &[String],
    pks: &[String],
) -> Result<HashMap<String, Vec<SqlValue>>> {
    let table = table.replace('"', "");
    let col_list = cols
        .iter()
        .map(|c| format!("\"{}\"", c.replace('"', "")))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn.prepare(&format!("SELECT {col_list} FROM \"{table}\""))?;
    let pk_idx: Vec<usize> = pks
        .iter()
        .filter_map(|pk| cols.iter().position(|c| c == pk))
        .collect();
    let n = cols.len();
    let mut out = HashMap::new();
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let mut vals = Vec::with_capacity(n);
        for i in 0..n {
            vals.push(row.get::<_, SqlValue>(i)?);
        }
        let key = pk_idx
            .iter()
            .map(|i| format_sql_value(&vals[*i]))
            .collect::<Vec<_>>()
            .join("\u{1f}");
        out.insert(key, vals);
    }
    Ok(out)
}

/// Make `tx`'s `table` rows equal to `temp`'s, via keyed INSERT/UPDATE/DELETE.
fn diff_apply_table(tx: &rusqlite::Transaction<'_>, temp: &Connection, table: &str) -> Result<()> {
    let (cols, pks) = table_columns(temp, table)?;
    if cols.is_empty() || pks.is_empty() {
        return Ok(());
    }
    let target = read_table_rows(temp, table, &cols, &pks)?;
    let current = read_table_rows(tx, table, &cols, &pks)?;
    let table_q = format!("\"{}\"", table.replace('"', ""));
    let col_list = cols
        .iter()
        .map(|c| format!("\"{}\"", c.replace('"', "")))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = (1..=cols.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let pk_idx: Vec<usize> = pks
        .iter()
        .filter_map(|pk| cols.iter().position(|c| c == pk))
        .collect();
    let where_pk = pks
        .iter()
        .enumerate()
        .map(|(i, pk)| format!("\"{}\" = ?{}", pk.replace('"', ""), i + 1))
        .collect::<Vec<_>>()
        .join(" AND ");

    for (key, vals) in &current {
        if !target.contains_key(key) {
            let pk_vals: Vec<&SqlValue> = pk_idx.iter().map(|i| &vals[*i]).collect();
            tx.execute(
                &format!("DELETE FROM {table_q} WHERE {where_pk}"),
                rusqlite::params_from_iter(pk_vals),
            )?;
        }
    }
    for (key, vals) in &target {
        match current.get(key) {
            None => {
                tx.execute(
                    &format!("INSERT INTO {table_q} ({col_list}) VALUES ({placeholders})"),
                    rusqlite::params_from_iter(vals.iter()),
                )?;
            }
            Some(cur) if cur != vals => {
                let non_pk: Vec<usize> = (0..cols.len()).filter(|i| !pk_idx.contains(i)).collect();
                if non_pk.is_empty() {
                    continue;
                }
                let set = non_pk
                    .iter()
                    .enumerate()
                    .map(|(j, i)| format!("\"{}\" = ?{}", cols[*i].replace('"', ""), j + 1))
                    .collect::<Vec<_>>()
                    .join(", ");
                let where_off = non_pk.len();
                let where_pk_off = pks
                    .iter()
                    .enumerate()
                    .map(|(i, pk)| format!("\"{}\" = ?{}", pk.replace('"', ""), where_off + i + 1))
                    .collect::<Vec<_>>()
                    .join(" AND ");
                let mut params: Vec<&SqlValue> = non_pk.iter().map(|i| &vals[*i]).collect();
                params.extend(pk_idx.iter().map(|i| &vals[*i]));
                tx.execute(
                    &format!("UPDATE {table_q} SET {set} WHERE {where_pk_off}"),
                    rusqlite::params_from_iter(params),
                )?;
            }
            _ => {}
        }
    }
    Ok(())
}

// ---------- rusqlite replica ----------

fn replica_root(config: &Config) -> PathBuf {
    Path::new(&config.git_data_dir)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("plugin-db-replicas")
}

fn replica_path(config: &Config, vault: &str, plugin: &str, name: &str) -> PathBuf {
    replica_root(config)
        .join(safe_component(vault))
        .join(safe_component(plugin))
        .join(format!("{}.sqlite", safe_component(name)))
}

/// Defang a path component (ids are validated upstream, but be defensive).
fn safe_component(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Probe-load the extension against a throwaway in-memory database, returning
/// the minted site id (hex) as evidence the extension is functional.
fn probe_extension(ext: &str) -> Result<String> {
    let conn = Connection::open_in_memory()?;
    // SAFETY: loading a trusted, operator-configured extension.
    unsafe {
        conn.load_extension_enable()?;
        let r = conn.load_extension(ext, Some(CRSQLITE_INIT));
        conn.load_extension_disable()?;
        r?;
    }
    let site: String =
        conn.query_row("SELECT lower(hex(crsql_site_id()))", [], |row| row.get(0))?;
    let _ = conn.query_row("SELECT crsql_finalize()", [], |_| Ok(()));
    Ok(site)
}

fn open_replica(config: &Config, path: &Path) -> Result<(Connection, bool)> {
    let ext = config
        .crsqlite_ext_path
        .as_ref()
        .ok_or_else(|| anyhow!("crsqlite extension not configured"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let is_new = !path.exists();
    let conn = Connection::open(path)?;
    // Replication, bootstrap, and git dumps may touch the same replica file
    // concurrently from blocking tasks; wait out the file lock instead of
    // surfacing spurious SQLITE_BUSY errors.
    conn.busy_timeout(Duration::from_secs(5))?;
    // SAFETY: loading a trusted, operator-configured extension.
    unsafe {
        conn.load_extension_enable()?;
        let r = conn.load_extension(ext, Some(CRSQLITE_INIT));
        conn.load_extension_disable()?;
        r?;
    }
    Ok((conn, is_new))
}

fn apply_to_replica(
    config: &Config,
    vault: &str,
    plugin: &str,
    name: &str,
    schema: &[String],
    batches: &[Batch],
    mut cursor: Cursor,
) -> Result<Cursor> {
    let path = replica_path(config, vault, plugin, name);
    let (mut conn, is_new) = open_replica(config, &path)?;

    if is_new {
        for stmt in schema {
            // crsql_as_crr is a SELECT; CREATE TABLE is DDL — both run via execute_batch.
            conn.execute_batch(stmt)
                .with_context(|| format!("apply schema stmt: {stmt}"))?;
        }
    }

    let tx = conn.transaction()?;
    {
        let mut insert = tx.prepare(
            "INSERT INTO crsql_changes \
             (\"table\", pk, cid, val, col_version, db_version, site_id, cl, seq) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        for batch in batches {
            let floor = cursor.get(&batch.site_id).copied().unwrap_or(0);
            if batch.to_db_version <= floor {
                continue;
            }
            for c in &batch.changes {
                if c.db_version <= floor {
                    continue;
                }
                insert.execute(rusqlite::params![
                    c.table,
                    b64_to_bytes(&c.pk),
                    c.cid,
                    json_to_sql(&c.val),
                    c.col_version,
                    c.db_version,
                    b64_to_bytes(&c.site_id),
                    c.cl,
                    c.seq,
                ])?;
            }
            let entry = cursor.entry(batch.site_id.clone()).or_insert(0);
            *entry = (*entry).max(batch.to_db_version);
        }
    }
    tx.commit()?;
    Ok(cursor)
}

/// Read the replica's full `crsql_changes` set past a per-site cursor, in the
/// same wire encoding the client publishes (base64 pk/site_id, tagged vals).
fn read_replica_changes(
    config: &Config,
    vault: &str,
    plugin: &str,
    name: &str,
    since: &Cursor,
) -> Result<Vec<ChangeRow>> {
    let path = replica_path(config, vault, plugin, name);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let (conn, _is_new) = open_replica(config, &path)?;
    let mut out = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT \"table\", pk, cid, val, col_version, db_version, site_id, cl, seq \
             FROM crsql_changes ORDER BY site_id, db_version, seq",
        )?;
        let rows = stmt.query_map([], |row| {
            let pk: Vec<u8> = row.get(1)?;
            let val: SqlValue = row.get(3)?;
            let site: Vec<u8> = row.get(6)?;
            Ok((
                ChangeRow {
                    table: row.get(0)?,
                    pk: bytes_to_b64(&pk),
                    cid: row.get(2)?,
                    val: sql_to_json(&val),
                    col_version: row.get(4)?,
                    db_version: row.get(5)?,
                    site_id: bytes_to_b64(&site),
                    cl: row.get(7)?,
                    seq: row.get(8)?,
                },
                site,
            ))
        })?;
        for r in rows {
            let (change, site) = r?;
            let floor = since.get(&bytes_to_hex(&site)).copied().unwrap_or(0);
            if change.db_version > floor {
                out.push(change);
            }
        }
    }
    let _ = conn.query_row("SELECT crsql_finalize()", [], |_| Ok(()));
    Ok(out)
}

/// Produce a deterministic SQL dump of a replica (user tables only) with a
/// trailing `-- crr: t1,t2` header recording the CRR tables.
fn dump_replica(config: &Config, vault: &str, plugin: &str, name: &str) -> Result<Option<String>> {
    let path = replica_path(config, vault, plugin, name);
    if !path.exists() {
        return Ok(None);
    }
    let (conn, _is_new) = open_replica(config, &path)?;

    // User tables (exclude sqlite_/crsql_ internals and cr-sqlite sidecar tables).
    let mut tables: Vec<(String, String)> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT name, sql FROM sqlite_master WHERE type='table' \
             AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'crsql_%' \
             AND name NOT LIKE '%__crsql_clock' AND name NOT LIKE '%__crsql_pks' \
             ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for r in rows {
            tables.push(r?);
        }
    }

    // CRR tables (detected by their sidecar clock table).
    let mut crr: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%__crsql_clock' ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for r in rows {
            crr.push(r?.trim_end_matches("__crsql_clock").to_string());
        }
    }

    let mut out = String::new();
    for (table, sql) in &tables {
        out.push_str(sql);
        out.push_str(";\n");
        dump_table_rows(&conn, table, &mut out)?;
        out.push('\n');
    }
    out.push_str(&format!("-- crr: {}\n", crr.join(",")));
    Ok(Some(out))
}

fn dump_table_rows(conn: &Connection, table: &str, out: &mut String) -> Result<()> {
    // Column names, in declared order.
    let cols: Vec<String> = {
        let mut stmt = conn.prepare(&format!(
            "PRAGMA table_info(\"{}\")",
            table.replace('"', "")
        ))?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        let mut v = Vec::new();
        for r in rows {
            v.push(r?);
        }
        v
    };
    if cols.is_empty() {
        return Ok(());
    }
    let col_list = cols
        .iter()
        .map(|c| format!("\"{}\"", c.replace('"', "")))
        .collect::<Vec<_>>()
        .join(", ");
    let order = cols
        .iter()
        .map(|c| format!("\"{}\"", c.replace('"', "")))
        .collect::<Vec<_>>()
        .join(", ");

    let mut stmt = conn.prepare(&format!(
        "SELECT {col_list} FROM \"{}\" ORDER BY {order}",
        table.replace('"', "")
    ))?;
    let n = cols.len();
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let mut vals = Vec::with_capacity(n);
        for i in 0..n {
            let v: SqlValue = row.get(i)?;
            vals.push(format_sql_value(&v));
        }
        out.push_str(&format!(
            "INSERT INTO \"{}\" ({col_list}) VALUES ({});\n",
            table.replace('"', ""),
            vals.join(", ")
        ));
    }
    Ok(())
}

fn format_sql_value(v: &SqlValue) -> String {
    match v {
        SqlValue::Null => "NULL".to_string(),
        SqlValue::Integer(i) => i.to_string(),
        SqlValue::Real(f) => {
            // Canonical float: shortest round-trippable form.
            let mut s = format!("{f}");
            if !s.contains('.') && !s.contains('e') && !s.contains('E') && f.is_finite() {
                s.push_str(".0");
            }
            s
        }
        SqlValue::Text(t) => format!("'{}'", t.replace('\'', "''")),
        SqlValue::Blob(b) => {
            let mut hex = String::with_capacity(b.len() * 2 + 3);
            hex.push_str("X'");
            for byte in b {
                hex.push_str(&format!("{byte:02X}"));
            }
            hex.push('\'');
            hex
        }
    }
}

// ---------- value codecs ----------

fn b64_to_bytes(s: &str) -> Vec<u8> {
    match base64::engine::general_purpose::STANDARD.decode(s) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("malformed base64 in plugin-db change row ({e}); substituting empty");
            Vec::new()
        }
    }
}

fn bytes_to_b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn bytes_to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for byte in b {
        s.push_str(&format!("{byte:02x}"));
    }
    s
}

/// Encode a replica value into the tagged JSON wire format the client uses
/// (`{"$blob": b64}` for blobs, `{"$int": "…"}` for ints beyond JS safe range).
fn sql_to_json(v: &SqlValue) -> JsonValue {
    const JS_MAX_SAFE: i64 = 9_007_199_254_740_991;
    match v {
        SqlValue::Null => JsonValue::Null,
        SqlValue::Integer(i) => {
            if i.abs() <= JS_MAX_SAFE {
                serde_json::json!(i)
            } else {
                serde_json::json!({ "$int": i.to_string() })
            }
        }
        SqlValue::Real(f) => serde_json::json!(f),
        SqlValue::Text(t) => serde_json::json!(t),
        SqlValue::Blob(b) => serde_json::json!({ "$blob": bytes_to_b64(b) }),
    }
}

fn json_to_sql(v: &JsonValue) -> SqlValue {
    match v {
        JsonValue::Null => SqlValue::Null,
        JsonValue::Bool(b) => SqlValue::Integer(if *b { 1 } else { 0 }),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        JsonValue::String(s) => SqlValue::Text(s.clone()),
        JsonValue::Object(map) => {
            if let Some(JsonValue::String(b64)) = map.get("$blob") {
                SqlValue::Blob(b64_to_bytes(b64))
            } else if let Some(JsonValue::String(int)) = map.get("$int") {
                SqlValue::Integer(int.parse().unwrap_or(0))
            } else {
                // A tag this server version does not know (future wire format?).
                // Surface it rather than silently storing NULL.
                tracing::warn!(
                    "unrecognized tagged value in plugin-db change row (keys: {:?}); storing NULL",
                    map.keys().collect::<Vec<_>>()
                );
                SqlValue::Null
            }
        }
        JsonValue::Array(_) => {
            tracing::warn!("unexpected JSON array value in plugin-db change row; storing NULL");
            SqlValue::Null
        }
    }
}

// ---------- SQL classification guards ----------

/// Reject SQL touching cr-sqlite/SQLite internals. Mirrors the client lint
/// (`src/pluginDb/SyncedPluginDatabase.ts`): case-insensitive substring match
/// for `crsql_` or `sqlite_`. These tables/functions are owned by the engine or
/// the replication layer — server-side writes into them would corrupt sync.
fn lint_sql(sql: &str) -> std::result::Result<(), String> {
    let lower = sql.to_ascii_lowercase();
    if lower.contains("crsql_") {
        return Err(format!(
            "SQL references cr-sqlite internals (crsql_); those are managed by replication"
        ));
    }
    if lower.contains("sqlite_") {
        return Err(format!(
            "SQL references SQLite internals (sqlite_); those are not writable from here"
        ));
    }
    Ok(())
}

/// The first keyword (leading ASCII-alphabetic run) of `sql`, upper-cased.
/// Leading whitespace is skipped; a leading comment is *not* stripped (a
/// statement starting with `--` or `/*` yields `None`, which every caller
/// rejects via the read/write keyword check). Keyword sniffing can't safely
/// classify writable CTEs, so `WITH` is accepted for reads only.
fn first_keyword(sql: &str) -> Option<String> {
    let s = sql.trim_start();
    let bytes = s.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return None;
    }
    let kw: String = s
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect();
    Some(kw.to_ascii_uppercase())
}

/// First keyword must be SELECT or WITH.
fn is_read_statement(sql: &str) -> bool {
    matches!(first_keyword(sql).as_deref(), Some("SELECT") | Some("WITH"))
}

/// First keyword must be INSERT, UPDATE, DELETE, or REPLACE. (DDL, PRAGMA,
/// ATTACH, BEGIN/COMMIT, VACUUM etc. are all rejected — the schema is owned by
/// plugin migrations on the client; WITH is excluded from writes deliberately:
/// writable CTEs are rare and keyword-sniffing WITH is ambiguous.)
fn is_write_statement(sql: &str) -> bool {
    matches!(
        first_keyword(sql).as_deref(),
        Some("INSERT") | Some("UPDATE") | Some("DELETE") | Some("REPLACE")
    )
}
// ---------- HTTP routes ----------

pub mod routes {
    use super::*;
    use axum::extract::{Path, Query, State};
    use axum::Json;
    use serde::Deserialize;
    use serde_json::Value;

    use crate::error::{AppError, AppResult};
    use crate::routes::{authorize_path, require_member};
    use crate::session::{now_millis, ApiPrincipal};
    use crate::state::AppState;
    use crate::ysweet::Level;

    /// `[A-Za-z0-9_-]{1,80}` without `__` — must match the client validation
    /// (`__` is the doc-id separator and would make ids ambiguous to parse).
    fn valid_id(s: &str) -> bool {
        !s.is_empty()
            && s.len() <= 80
            && !s.contains("__")
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    }

    fn pseudo_path(plugin: &str, name: &str) -> String {
        format!(".realtime/plugin-dbs/{plugin}/{name}")
    }

    #[derive(Deserialize)]
    pub struct ChangesQuery {
        /// JSON cursor `{siteHex: dbVersion}`.
        pub since: Option<String>,
    }

    /// Shared guard: validate ids, pin the cursor principal to this vault,
    /// require membership, and check the path ACL. `need_full` rejects a
    /// read-only ACL level for mutating endpoints. Returns the git principal
    /// for attribution (1-day TTL, matching the old `AuthUser` guard).
    pub(crate) async fn guard_principal(
        state: &AppState,
        principal: &ApiPrincipal,
        vault_id: &str,
        plugin: &str,
        name: &str,
        need_full: bool,
    ) -> AppResult<crate::state::Principal> {
        if !valid_id(plugin) || !valid_id(name) {
            return Err(AppError::BadRequest("invalid plugin db id".into()));
        }
        principal.require_vault(vault_id)?;
        require_member(state, &principal.user.id, vault_id).await?;
        let level = authorize_path(state, &principal.user, vault_id, &pseudo_path(plugin, name))
            .await?;
        if need_full && level == Level::ReadOnly {
            return Err(AppError::Forbidden);
        }
        Ok(principal.to_git_principal(now_millis() + 24 * 60 * 60 * 1000))
    }

    // ---------- shared inner fns (REST + MCP) ----------

    pub(crate) async fn list_inner(
        state: &AppState,
        principal: &ApiPrincipal,
        vault_id: &str,
    ) -> AppResult<Vec<PluginDbInfo>> {
        principal.require_vault(vault_id)?;
        require_member(state, &principal.user.id, vault_id).await?;
        state
            .plugindb
            .list_dbs(vault_id)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))
    }

    pub(crate) async fn query_inner(
        state: &AppState,
        principal: &ApiPrincipal,
        vault_id: &str,
        plugin: &str,
        name: &str,
        sql: &str,
        params: &[JsonValue],
        limit: Option<usize>,
    ) -> AppResult<QuerySqlResult> {
        guard_principal(state, principal, vault_id, plugin, name, false).await?;
        state
            .plugindb
            .query_sql(vault_id, plugin, name, sql, params, limit)
            .await
    }

    pub(crate) async fn execute_inner(
        state: &AppState,
        principal: &ApiPrincipal,
        vault_id: &str,
        plugin: &str,
        name: &str,
        statements: &[ExecuteStatement],
    ) -> AppResult<ExecuteSqlResult> {
        let git_principal =
            guard_principal(state, principal, vault_id, plugin, name, true).await?;
        let res = state
            .plugindb
            .execute_sql(vault_id, plugin, name, statements)
            .await?;
        // Attribute the write in git (same pair as touch).
        state.plugindb.mark_write(vault_id, plugin, name).await;
        state.git.mark_write(vault_id, &git_principal).await;
        Ok(res)
    }

    // ---------- REST handlers ----------

    /// `GET /api/vaults/{id}/plugin-dbs/{plugin}/{name}/changes?since=…`
    pub async fn get_changes(
        State(state): State<AppState>,
        principal: ApiPrincipal,
        Path((vault_id, plugin, name)): Path<(String, String, String)>,
        Query(q): Query<ChangesQuery>,
    ) -> AppResult<Json<Value>> {
        guard_principal(&state, &principal, &vault_id, &plugin, &name, false).await?;
        let since: Cursor = q
            .since
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        let changes = state
            .plugindb
            .bootstrap_changes(&vault_id, &plugin, &name, &since)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
        Ok(Json(serde_json::json!({ "changes": changes })))
    }

    /// `POST /api/vaults/{id}/plugin-dbs/{plugin}/{name}/touch`
    pub async fn touch(
        State(state): State<AppState>,
        principal: ApiPrincipal,
        Path((vault_id, plugin, name)): Path<(String, String, String)>,
    ) -> AppResult<Json<Value>> {
        let git_principal =
            guard_principal(&state, &principal, &vault_id, &plugin, &name, true).await?;
        // Replicate the DB changes, and produce a user-attributed git commit.
        state.plugindb.mark_write(&vault_id, &plugin, &name).await;
        state.git.mark_write(&vault_id, &git_principal).await;
        Ok(Json(serde_json::json!({ "ok": true })))
    }

    /// `DELETE /api/vaults/{id}/plugin-dbs/{plugin}/{name}` — purge (irreversible).
    pub async fn delete_plugin_db(
        State(state): State<AppState>,
        principal: ApiPrincipal,
        Path((vault_id, plugin, name)): Path<(String, String, String)>,
    ) -> AppResult<Json<Value>> {
        let git_principal =
            guard_principal(&state, &principal, &vault_id, &plugin, &name, true).await?;
        state
            .plugindb
            .purge(&vault_id, &plugin, &name)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
        // A clean "database deleted" commit reflects the removed dump.
        state.git.mark_write(&vault_id, &git_principal).await;
        Ok(Json(serde_json::json!({ "deleted": true })))
    }

    // ---------- new SQL endpoints ----------

    #[derive(Deserialize)]
    pub struct QueryBody {
        pub sql: String,
        #[serde(default)]
        pub params: Vec<JsonValue>,
        pub limit: Option<usize>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ExecuteStatementBody {
        pub sql: String,
        #[serde(default)]
        pub params: Vec<JsonValue>,
    }

    #[derive(Deserialize)]
    pub struct ExecuteBody {
        pub statements: Vec<ExecuteStatementBody>,
    }

    /// `GET /api/vaults/{id}/plugin-dbs` — list databases the server replicates.
    pub async fn list_plugin_dbs(
        State(state): State<AppState>,
        principal: ApiPrincipal,
        Path(vault_id): Path<String>,
    ) -> AppResult<Json<Value>> {
        let dbs = list_inner(&state, &principal, &vault_id).await?;
        Ok(Json(serde_json::json!({ "databases": dbs })))
    }

    /// `POST /api/vaults/{id}/plugin-dbs/{plugin}/{name}/query` — read-only SELECT.
    pub async fn query_plugin_db(
        State(state): State<AppState>,
        principal: ApiPrincipal,
        Path((vault_id, plugin, name)): Path<(String, String, String)>,
        Json(body): Json<QueryBody>,
    ) -> AppResult<Json<QuerySqlResult>> {
        let res =
            query_inner(&state, &principal, &vault_id, &plugin, &name, &body.sql, &body.params, body.limit)
                .await?;
        Ok(Json(res))
    }

    /// `POST /api/vaults/{id}/plugin-dbs/{plugin}/{name}/execute` — write batch.
    pub async fn execute_plugin_db(
        State(state): State<AppState>,
        principal: ApiPrincipal,
        Path((vault_id, plugin, name)): Path<(String, String, String)>,
        Json(body): Json<ExecuteBody>,
    ) -> AppResult<Json<ExecuteSqlResult>> {
        let statements: Vec<ExecuteStatement> = body
            .statements
            .into_iter()
            .map(|s| ExecuteStatement { sql: s.sql, params: s.params })
            .collect();
        let res =
            execute_inner(&state, &principal, &vault_id, &plugin, &name, &statements).await?;
        Ok(Json(res))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_change(site_b64: &str, db_version: i64) -> ChangeRow {
        ChangeRow {
            table: "tasks".into(),
            pk: "AQ==".into(),
            cid: "title".into(),
            val: JsonValue::String("hi".into()),
            col_version: 1,
            db_version,
            site_id: site_b64.into(),
            cl: 1,
            seq: 0,
        }
    }

    #[test]
    fn format_values_are_deterministic() {
        assert_eq!(format_sql_value(&SqlValue::Null), "NULL");
        assert_eq!(format_sql_value(&SqlValue::Integer(42)), "42");
        assert_eq!(format_sql_value(&SqlValue::Real(1.0)), "1.0");
        assert_eq!(format_sql_value(&SqlValue::Text("a'b".into())), "'a''b'");
        assert_eq!(
            format_sql_value(&SqlValue::Blob(vec![0x00, 0xAB, 0xFF])),
            "X'00ABFF'"
        );
    }

    #[test]
    fn json_to_sql_decodes_tagged_blob_and_int() {
        let blob = serde_json::json!({ "$blob": "AQID" });
        assert!(matches!(json_to_sql(&blob), SqlValue::Blob(b) if b == vec![1, 2, 3]));
        let int = serde_json::json!({ "$int": "9007199254740993" });
        assert!(matches!(
            json_to_sql(&int),
            SqlValue::Integer(9007199254740993)
        ));
    }

    fn ext_config() -> Option<Config> {
        let ext = std::env::var("CRSQLITE_EXT_PATH")
            .ok()
            .filter(|p| Path::new(p).exists())?;
        let mut cfg = Config::test_default();
        cfg.crsqlite_ext_path = Some(ext);
        let dir = std::env::temp_dir().join(format!("realtime-pdb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).ok();
        // replica_root() derives from git_data_dir's parent.
        cfg.git_data_dir = dir.join("git").display().to_string();
        Some(cfg)
    }

    #[test]
    fn replica_dump_is_deterministic_and_restorable() {
        let Some(config) = ext_config() else {
            eprintln!("skipping replica test: CRSQLITE_EXT_PATH not set");
            return;
        };
        let path = replica_path(&config, "v", "p", "n");
        let (conn, _new) = open_replica(&config, &path).unwrap();
        conn.execute_batch("CREATE TABLE tasks (id PRIMARY KEY NOT NULL, title)")
            .unwrap();
        conn.execute_batch("SELECT crsql_as_crr('tasks')").unwrap();
        conn.execute("INSERT INTO tasks (id, title) VALUES ('a', 'x')", [])
            .unwrap();
        conn.execute("INSERT INTO tasks (id, title) VALUES ('b', 'y')", [])
            .unwrap();
        conn.execute("SELECT crsql_finalize()", []).ok();
        drop(conn);

        let d1 = dump_replica(&config, "v", "p", "n").unwrap().unwrap();
        let d2 = dump_replica(&config, "v", "p", "n").unwrap().unwrap();
        assert_eq!(d1, d2, "dump must be byte-identical across runs");
        assert!(d1.contains("-- crr: tasks"));
        assert!(d1.contains("INSERT INTO \"tasks\""));
    }

    #[test]
    fn dump_rollback_diffs_rows_and_replays_onto_fresh_replica() {
        let Some(config) = ext_config() else {
            eprintln!("skipping rollback test: CRSQLITE_EXT_PATH not set");
            return;
        };
        // Build a replica, dump it (the rollback target), then mutate it.
        let path = replica_path(&config, "v", "p", "n");
        {
            let (conn, _new) = open_replica(&config, &path).unwrap();
            conn.execute_batch("CREATE TABLE tasks (id PRIMARY KEY NOT NULL, title)")
                .unwrap();
            conn.execute_batch("SELECT crsql_as_crr('tasks')").unwrap();
            conn.execute("INSERT INTO tasks (id, title) VALUES ('a', 'x')", [])
                .unwrap();
            conn.execute("SELECT crsql_finalize()", []).ok();
        }
        let target = dump_replica(&config, "v", "p", "n").unwrap().unwrap();
        {
            let (conn, _new) = open_replica(&config, &path).unwrap();
            conn.execute("UPDATE tasks SET title = 'changed' WHERE id = 'a'", [])
                .unwrap();
            conn.execute("INSERT INTO tasks (id, title) VALUES ('b', 'y')", [])
                .unwrap();
            conn.execute("SELECT crsql_finalize()", []).ok();
        }
        assert!(schema_matches(&config, "v", "p", "n", &target).unwrap());

        // Roll back: replica must equal the dumped state again, and the
        // produced changes must replay onto a fresh replica to the same state.
        let (rows, _site_hex, _site_b64, _post) =
            apply_dump_rollback(&config, "v", "p", "n", &target).unwrap();
        assert!(!rows.is_empty());
        let after = dump_replica(&config, "v", "p", "n").unwrap().unwrap();
        assert_eq!(after, target, "replica must match the dump after rollback");

        // Fresh replica at the *mutated* state, then apply the rollback batch.
        let path2 = replica_path(&config, "v2", "p", "n");
        {
            let (conn, _new) = open_replica(&config, &path2).unwrap();
            conn.execute_batch("CREATE TABLE tasks (id PRIMARY KEY NOT NULL, title)")
                .unwrap();
            conn.execute_batch("SELECT crsql_as_crr('tasks')").unwrap();
            let mut insert = conn
                .prepare(
                    "INSERT INTO crsql_changes \
                     (\"table\", pk, cid, val, col_version, db_version, site_id, cl, seq) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                )
                .unwrap();
            for c in &rows {
                insert
                    .execute(rusqlite::params![
                        c.table,
                        b64_to_bytes(&c.pk),
                        c.cid,
                        json_to_sql(&c.val),
                        c.col_version,
                        c.db_version,
                        b64_to_bytes(&c.site_id),
                        c.cl,
                        c.seq,
                    ])
                    .unwrap();
            }
            drop(insert);
            conn.execute("SELECT crsql_finalize()", []).ok();
        }
        let replayed = dump_replica(&config, "v2", "p", "n").unwrap().unwrap();
        // Row contents must converge on the dumped state (whole-dump equality
        // would also compare nothing else here since the schema is identical).
        assert_eq!(
            replayed, target,
            "replayed batch must reach the dumped state"
        );
    }

    #[test]
    fn bootstrap_filters_by_cursor() {
        // A batch from site "AAA" covering db_version 1..=3.
        let batch = Batch {
            id: "b1".into(),
            site_id: "AAA".into(),
            from_db_version: 0,
            to_db_version: 3,
            schema_version: 1,
            changes: vec![sample_change("AAA", 1), sample_change("AAA", 3)],
            format: crate::caps::PLUGIN_DB_SYNC.into(),
        };
        let view = DocView {
            batches: vec![batch],
            ..Default::default()
        };
        // Reproduce the bootstrap filter logic for cursor {AAA:1}.
        let mut since: Cursor = HashMap::new();
        since.insert("AAA".into(), 1);
        let mut out = Vec::new();
        for batch in &view.batches {
            let floor = since.get(&batch.site_id).copied().unwrap_or(0);
            if batch.to_db_version <= floor {
                continue;
            }
            for c in &batch.changes {
                if c.db_version > floor {
                    out.push(c.clone());
                }
            }
        }
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].db_version, 3);
    }
    #[test]
    fn lint_sql_rejects_crsql_and_sqlite_internals() {
        assert!(lint_sql("SELECT crsql_site_id()").is_err());
        assert!(lint_sql("SELECT * FROM sqlite_master").is_err());
        assert!(lint_sql("select CrsQL_db_version()").is_err());
        assert!(lint_sql("select SQLite_master").is_err());
        assert!(lint_sql("INSERT INTO tasks VALUES (1)").is_ok());
        assert!(lint_sql("  select 1").is_ok());
    }

    #[test]
    fn is_read_statement_accepts_select_and_with() {
        assert!(is_read_statement("SELECT 1"));
        assert!(is_read_statement("  with t as (select 1) select * from t"));
        assert!(is_read_statement("select * from tasks"));
        assert!(!is_read_statement("INSERT INTO tasks VALUES (1)"));
        assert!(!is_read_statement("CREATE TABLE x (id)"));
        assert!(!is_read_statement("-- comment\nSELECT 1"));
        assert!(!is_read_statement(""));
        assert!(!is_read_statement("   "));
    }

    #[test]
    fn is_write_statement_accepts_mutating_keywords_only() {
        assert!(is_write_statement("INSERT INTO tasks VALUES (1)"));
        assert!(is_write_statement("  update tasks set title='x'"));
        assert!(is_write_statement("DELETE FROM tasks"));
        assert!(is_write_statement("replace INTO tasks VALUES (1)"));
        // WITH is rejected for writes: writable CTEs are rare and sniffing WITH
        // as a write keyword would be ambiguous.
        assert!(!is_write_statement("WITH t AS (SELECT 1) INSERT INTO tasks SELECT * FROM t"));
        assert!(!is_write_statement("SELECT 1"));
        assert!(!is_write_statement("CREATE TABLE x (id)"));
        assert!(!is_write_statement("PRAGMA query_only = ON"));
        assert!(!is_write_statement("BEGIN"));
        assert!(!is_write_statement("ATTACH 'x.db' AS other"));
        assert!(!is_write_statement("VACUUM"));
        assert!(!is_write_statement(""));
        assert!(!is_write_statement("-- comment\nINSERT INTO tasks VALUES (1)"));
    }
}
