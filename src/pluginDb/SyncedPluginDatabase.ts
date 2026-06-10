/**
 * The per-(pluginId,name) sync engine: an in-memory cr-sqlite database kept in
 * sync with peers through a Y.Doc batch log, persisted to a local snapshot, and
 * bootstrapped from / reconciled with the server replica.
 *
 * One instance is shared (refcounted) across all `open()` callers for the same
 * database; see {@link RealtimeSqlAPI} in api.ts.
 */

import * as Y from "yjs";
import type { DB, SQLite3 } from "./crsqlite";
import {
	openMemoryDb,
	readChangesForSite,
	applyChanges,
	currentDbVersion,
	hexToBytes,
	bytesToHex,
	base64ToBytes,
} from "./crsqlite";
import { PluginDbSync, type PluginDbDocHandle } from "./PluginDbSync";
import {
	captureSnapshot,
	parseSnapshot,
	serializeSnapshot,
	restoreSnapshot,
} from "./snapshot";
import type { Batch, ChangeRow, Cursor, DbState, DbErrorReason, RemoteChange, SqlValue } from "./types";
import { MAX_BATCH_ROWS, SYNC_FORMAT, isValidId } from "./types";

// `SqlTx` / `MigrateFn` are part of the published plugin API surface.
import type { MigrateFn, SqlTx } from "@realtime-md/plugin-api-types";
export type { MigrateFn, SqlTx };

export interface SyncedPluginDatabaseOptions {
	vaultId: string;
	pluginId: string;
	name: string;
	schemaVersion: number;
	migrate: MigrateFn;
	/**
	 * Resolve the cr-sqlite WASM asset to a (same-origin) URL. Omit in production
	 * to use the esbuild-inlined data URL; tests pass a node data URL.
	 */
	locateWasm?: (file: string) => string;
	/** Build the per-DB Y.Doc transport handle. */
	makeDoc: (docId: string) => PluginDbDocHandle;
	/** Read the persisted snapshot text (null if none). */
	loadSnapshot: () => Promise<string | null>;
	/** Persist the snapshot text atomically. */
	saveSnapshot: (text: string) => Promise<void>;
	/** Remove the persisted snapshot. */
	deleteSnapshot: () => Promise<void>;
	/** Pull the full server changeset for a cursor (bootstrap / rebase). */
	bootstrap?: (cursor: Cursor) => Promise<ChangeRow[]>;
	/** Notify the server that we published (debounced upstream). */
	touch?: () => void;
	/** Optional repair hook after remote applies. */
	onMergeReview?: (tables: string[]) => void | Promise<void>;
}

const PUBLISH_DEBOUNCE_MS = 250;
const SNAPSHOT_DEBOUNCE_MS = 1500;

export class SyncedPluginDatabase {
	readonly pluginId: string;
	readonly name: string;
	readonly vaultId: string;
	readonly docId: string;
	refcount = 0;

	private opts: SyncedPluginDatabaseOptions;
	private sqlite: SQLite3 | null = null;
	private db: DB | null = null;
	private sync: PluginDbSync | null = null;
	private siteHex = "";
	private schemaVersion: number;

	private cursor: Cursor = {};
	private published: Cursor = {};
	private appliedBatchIds = new Set<string>();
	private bufferedBatches: Batch[] = [];
	/** Serializes apply passes so two observer callbacks never interleave. */
	private applyChain: Promise<void> = Promise.resolve();

	private _state: DbState = "loading-wasm";
	private _errorReason: DbErrorReason | null = null;
	private stateListeners = new Set<(s: DbState) => void>();
	private remoteListeners = new Set<(c: RemoteChange) => void>();
	private liveWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

	private publishTimer: ReturnType<typeof setTimeout> | null = null;
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	private unobserveBatches: (() => void) | null = null;
	private unobserveMeta: (() => void) | null = null;
	private startPromise: Promise<void> | null = null;
	private closed = false;

	constructor(opts: SyncedPluginDatabaseOptions) {
		if (!isValidId(opts.pluginId)) throw new Error(`invalid pluginId: ${opts.pluginId}`);
		if (!isValidId(opts.name)) throw new Error(`invalid database name: ${opts.name}`);
		this.opts = opts;
		this.pluginId = opts.pluginId;
		this.name = opts.name;
		this.vaultId = opts.vaultId;
		this.schemaVersion = opts.schemaVersion;
		this.docId = `${opts.vaultId}__plugindb__${opts.pluginId}__${opts.name}`;
	}

	// --- state -----------------------------------------------------------------

	get state(): DbState {
		return this._state;
	}

	get errorReason(): DbErrorReason | null {
		return this._errorReason;
	}

	private setState(state: DbState, reason: DbErrorReason | null = null): void {
		this._state = state;
		this._errorReason = reason;
		for (const cb of this.stateListeners) {
			try {
				cb(state);
			} catch (e) {
				console.error("[Realtime] sql onStateChange listener failed", e);
			}
		}
		if (state === "live") {
			const waiters = this.liveWaiters;
			this.liveWaiters = [];
			for (const w of waiters) w.resolve();
		} else if (state === "error") {
			const err = new Error(`database ${this.pluginId}/${this.name} entered error state (${reason ?? "unknown"})`);
			const waiters = this.liveWaiters;
			this.liveWaiters = [];
			for (const w of waiters) w.reject(err);
		}
	}

	onStateChange(cb: (s: DbState) => void): () => void {
		this.stateListeners.add(cb);
		return () => this.stateListeners.delete(cb);
	}

	onRemoteChange(cb: (c: RemoteChange) => void): () => void {
		this.remoteListeners.add(cb);
		return () => this.remoteListeners.delete(cb);
	}

	whenLive(): Promise<void> {
		if (this._state === "live") return Promise.resolve();
		if (this._state === "error") {
			return Promise.reject(new Error(`database ${this.pluginId}/${this.name} is in an error state`));
		}
		return new Promise((resolve, reject) => this.liveWaiters.push({ resolve, reject }));
	}

	// --- lifecycle -------------------------------------------------------------

	start(): Promise<void> {
		if (!this.startPromise) this.startPromise = this.doStart();
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		try {
			const { getSqlite } = await import("./crsqlite");
			this.setState("loading-wasm");
			this.sqlite = await getSqlite(this.opts.locateWasm).catch((e) => {
				throw new WasmError(e instanceof Error ? e.message : String(e));
			});
			this.db = await openMemoryDb(this.sqlite);
			this.siteHex = this.db.siteid.toLowerCase();

			// Build the transport + Yjs view.
			this.sync = new PluginDbSync(this.opts.makeDoc(this.docId));

			this.setState("restoring");
			const restored = await this.tryRestoreSnapshot();
			if (!restored) {
				await this.runMigrate(0);
				await this.bootstrapFromServer();
			}

			await this.sync.whenSynced();
			if (this.closed) return;

			// Tombstone check: a deleted DB must not come back to life.
			if (this.sync.getDeletedAt() !== null) {
				await this.handleTombstoned();
				return;
			}

			this.setState("syncing");
			// Publish the CRR schema so the server can build a replica + git dump.
			await this.publishSchema();
			// Catch up on any batches already present, then start observing.
			await this.enqueueApply(this.sync.listBatches());
			this.unobserveBatches = this.sync.observeBatches((batches) => this.applyBatches(batches));
			this.unobserveMeta = this.sync.observeMeta(() => this.onMetaChanged());

			// Crash recovery: republish anything we produced (migrate/local edits)
			// that never made it into the log.
			await this.publishNow();

			// The catch-up pass may have parked us in needs-migration; don't
			// override that (whenLive resolves only after the schema upgrade).
			if (this._state === "syncing") this.setState("live");
			this.scheduleSnapshot();
		} catch (e) {
			const reason: DbErrorReason = e instanceof WasmError ? "wasm" : "unknown";
			console.error(`[Realtime] failed to start plugin db ${this.docId}`, e);
			this.setState("error", reason);
			throw e;
		}
	}

	private async tryRestoreSnapshot(): Promise<boolean> {
		try {
			const text = await this.opts.loadSnapshot();
			if (!text) return false;
			const snap = parseSnapshot(text);
			if (!snap) return false;
			await restoreSnapshot(this.db!, snap);
			this.cursor = snap.cursors;
			this.published = snap.published;
			this.siteHex = this.db!.siteid.toLowerCase();
			if (snap.schemaVersion < this.schemaVersion) {
				await this.runMigrate(snap.schemaVersion);
			}
			return true;
		} catch (e) {
			console.warn(`[Realtime] snapshot restore failed for ${this.docId}; bootstrapping`, e);
			// Discard a corrupt snapshot and fall back to a fresh DB + bootstrap.
			await this.opts.deleteSnapshot().catch(() => {});
			await this.resetDb();
			return false;
		}
	}

	private async resetDb(): Promise<void> {
		if (this.db) await this.db.close().catch(() => {});
		this.db = await openMemoryDb(this.sqlite!);
		this.siteHex = this.db.siteid.toLowerCase();
		this.cursor = {};
		this.published = {};
		this.appliedBatchIds.clear();
	}

	private async runMigrate(fromVersion: number): Promise<void> {
		await this.db!.tx(async (tx) => {
			await this.opts.migrate(this.wrapTx(tx as unknown as DB, false), fromVersion);
		});
	}

	/** The schema version this engine is currently running at. */
	get currentSchemaVersion(): number {
		return this.schemaVersion;
	}

	/**
	 * Upgrade a *running* engine to a newer schema version (a consumer re-opened
	 * with a higher `schemaVersion`). Runs the new `migrate` from the old
	 * version, republishes the schema, then drains any batches that were
	 * buffered while we were behind (clearing `needs-migration`).
	 */
	async upgradeSchema(newVersion: number, migrate: MigrateFn): Promise<void> {
		if (this.closed || !this.db) return;
		if (newVersion <= this.schemaVersion) return;
		const fromVersion = this.schemaVersion;
		this.opts.migrate = migrate;
		await this.runMigrate(fromVersion);
		this.schemaVersion = newVersion;
		await this.publishSchema();
		// The migration itself may have produced local changes.
		await this.publishNow();
		await this.drainBuffered();
		this.scheduleSnapshot();
	}

	/**
	 * Re-apply batches buffered while our schema was behind. Anything still too
	 * new is re-buffered by the apply pass; if the buffer fully drains, the
	 * engine leaves `needs-migration`.
	 */
	private async drainBuffered(): Promise<void> {
		const buffered = this.bufferedBatches;
		if (buffered.length === 0) {
			if (this._state === "needs-migration") this.setState("live");
			return;
		}
		this.bufferedBatches = [];
		await this.enqueueApply(buffered);
		if (this.bufferedBatches.length === 0 && this._state === "needs-migration") {
			this.setState("live");
		}
	}

	private async bootstrapFromServer(): Promise<void> {
		if (!this.opts.bootstrap) return;
		this.setState("bootstrapping");
		try {
			const rows = await this.opts.bootstrap(this.cursor);
			if (rows.length > 0) {
				await this.db!.tx(async (tx) => {
					await applyChanges(tx as unknown as DB, rows);
				});
				// Advance the applied cursor to the high-water mark per site.
				for (const r of rows) {
					const site = bytesToHex(base64ToBytes(r.site_id));
					this.cursor[site] = Math.max(this.cursor[site] ?? 0, r.db_version);
				}
			}
		} catch (e) {
			console.warn(`[Realtime] bootstrap failed for ${this.docId}`, e);
		}
	}

	private async handleTombstoned(): Promise<void> {
		await this.opts.deleteSnapshot().catch(() => {});
		if (this.db) await this.db.close().catch(() => {});
		this.db = null;
		this.setState("error", "deleted");
	}

	private onMetaChanged(): void {
		if (this.closed || !this.sync) return;
		if (this.sync.getDeletedAt() !== null && this._state !== "error") {
			void this.handleTombstoned();
		}
	}

	// --- queries ---------------------------------------------------------------

	private assertReady(): DB {
		if (this.closed || !this.db) throw new Error(`database ${this.pluginId}/${this.name} is not open`);
		if (this._state === "error" && this._errorReason === "deleted") {
			throw new DeletedError(this.pluginId, this.name);
		}
		return this.db;
	}

	private lint(sql: string): void {
		if (/\b(crsql_|sqlite_)/i.test(sql)) {
			throw new Error(
				"exec/query may not touch crsql_* or sqlite_* internals; define schema in migrate()",
			);
		}
	}

	async exec(sql: string, bind: SqlValue[] = []): Promise<void> {
		const db = this.assertReady();
		this.lint(sql);
		await db.exec(sql, bind as never[]);
		this.schedulePublish();
		this.scheduleSnapshot();
	}

	async query<T = Record<string, SqlValue>>(sql: string, bind: SqlValue[] = []): Promise<T[]> {
		const db = this.assertReady();
		this.lint(sql);
		return db.execO<T & {}>(sql, bind as never[]);
	}

	async transaction<T>(cb: (tx: SqlTx) => Promise<T>): Promise<T> {
		const db = this.assertReady();
		let result!: T;
		await db.tx(async (tx) => {
			result = await cb(this.wrapTx(tx as unknown as DB, true));
		});
		this.schedulePublish();
		this.scheduleSnapshot();
		return result;
	}

	private wrapTx(tx: DB, lint: boolean): SqlTx {
		return {
			exec: async (sql, bind = []) => {
				if (lint) this.lint(sql);
				await tx.exec(sql, bind as never[]);
			},
			query: async <T = Record<string, SqlValue>>(sql: string, bind: SqlValue[] = []) => {
				if (lint) this.lint(sql);
				return (await tx.execO<Record<string, SqlValue>>(sql, bind as never[])) as T[];
			},
		};
	}

	// --- publish ---------------------------------------------------------------

	private async publishSchema(): Promise<void> {
		if (!this.db || !this.sync) return;
		try {
			const { collectSchema } = await import("./snapshot");
			const ddl = await collectSchema(this.db);
			if (ddl.length > 0) this.sync.setSchema(ddl, this.schemaVersion);
		} catch (e) {
			console.warn(`[Realtime] failed to publish schema for ${this.docId}`, e);
		}
	}

	private schedulePublish(): void {
		if (this.publishTimer || this.closed) return;
		this.publishTimer = setTimeout(() => {
			this.publishTimer = null;
			void this.publishNow();
		}, PUBLISH_DEBOUNCE_MS);
	}

	/** Append batches for every change this device has produced past its cursor. */
	private async publishNow(): Promise<void> {
		if (this.closed || !this.db || !this.sync) return;
		// Every site id we own: the current one plus any we have published before
		// (crash recovery across restarts that minted new site ids).
		const ownSites = new Set<string>([this.siteHex, ...Object.keys(this.published)]);
		let publishedAny = false;
		for (const site of ownSites) {
			const since = this.published[site] ?? 0;
			let rows: ChangeRow[];
			try {
				rows = await readChangesForSite(this.db, hexToBytes(site), since);
			} catch (e) {
				console.warn(`[Realtime] reading changes for ${site} failed`, e);
				continue;
			}
			if (rows.length === 0) continue;
			for (let i = 0; i < rows.length; i += MAX_BATCH_ROWS) {
				const chunk = rows.slice(i, i + MAX_BATCH_ROWS);
				const batch: Batch = {
					id: makeBatchId(),
					siteId: site,
					fromDbVersion: since,
					toDbVersion: chunk[chunk.length - 1].db_version,
					schemaVersion: this.schemaVersion,
					changes: chunk,
					createdAt: Date.now(),
					format: SYNC_FORMAT,
				};
				this.appliedBatchIds.add(batch.id);
				this.sync.appendBatch(batch);
				this.published[site] = batch.toDbVersion;
				publishedAny = true;
			}
		}
		if (publishedAny) {
			this.sync.setCursor(this.siteHex, this.cursor);
			this.opts.touch?.();
			this.scheduleSnapshot();
		}
	}

	// --- apply remote ----------------------------------------------------------

	private applyBatches(batches: Batch[]): void {
		void this.enqueueApply(batches);
	}

	/** Run an apply pass after every previously queued pass has finished. */
	private enqueueApply(batches: Batch[]): Promise<void> {
		const next = this.applyChain.then(() => this.applyBatchesAsync(batches));
		this.applyChain = next.catch((e) => {
			console.error(`[Realtime] apply pass failed for ${this.docId}`, e);
		});
		return next;
	}

	private async applyBatchesAsync(batches: Batch[]): Promise<void> {
		if (this.closed || !this.db || !this.sync) return;
		const compacted = this.sync.getCompactedThrough();
		const touchedTables = new Set<string>();
		let cursorChanged = false;

		for (const batch of batches) {
			if (this.appliedBatchIds.has(batch.id)) continue;
			if (batch.siteId === this.siteHex) {
				this.appliedBatchIds.add(batch.id);
				continue;
			}
			if (batch.format !== SYNC_FORMAT) {
				// Unknown wire format: refuse rather than corrupt.
				this.appliedBatchIds.add(batch.id);
				continue;
			}
			const applied = this.cursor[batch.siteId] ?? 0;
			if (batch.toDbVersion <= applied) {
				this.appliedBatchIds.add(batch.id);
				continue;
			}
			// Schema too new for us: buffer and surface needs-migration.
			if (batch.schemaVersion > this.schemaVersion) {
				if (!this.bufferedBatches.some((b) => b.id === batch.id)) this.bufferedBatches.push(batch);
				if (this._state !== "needs-migration") this.setState("needs-migration");
				continue;
			}
			// Gap detection: a needed range was compacted away → rebuild from server.
			if (batch.fromDbVersion > applied && (compacted[batch.siteId] ?? 0) >= batch.fromDbVersion) {
				void this.rebaseFromServer();
				return;
			}

			try {
				await this.db.tx(async (tx) => {
					await applyChanges(tx as unknown as DB, batch.changes);
				});
			} catch (e) {
				console.error(`[Realtime] failed to apply batch ${batch.id} for ${this.docId}`, e);
				continue;
			}
			for (const c of batch.changes) touchedTables.add(c.table);
			this.cursor[batch.siteId] = Math.max(applied, batch.toDbVersion);
			this.appliedBatchIds.add(batch.id);
			cursorChanged = true;
		}

		if (cursorChanged) {
			this.sync.setCursor(this.siteHex, this.cursor);
			this.scheduleSnapshot();
		}
		if (touchedTables.size > 0) {
			const tables = [...touchedTables];
			for (const cb of this.remoteListeners) {
				try {
					cb({ tables });
				} catch (e) {
					console.error("[Realtime] sql onRemoteChange listener failed", e);
				}
			}
			if (this.opts.onMergeReview) {
				try {
					await this.opts.onMergeReview(tables);
				} catch (e) {
					console.error("[Realtime] onMergeReview failed", e);
				}
			}
		}
	}

	// --- snapshot --------------------------------------------------------------

	private scheduleSnapshot(): void {
		if (this.snapshotTimer || this.closed) return;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			void this.persistSnapshot();
		}, SNAPSHOT_DEBOUNCE_MS);
	}

	private async persistSnapshot(): Promise<void> {
		// Note: intentionally not guarded on `this.closed` — close() flips that
		// flag before flushing the final snapshot.
		if (!this.db) return;
		try {
			const snap = await captureSnapshot(this.db, this.schemaVersion, this.cursor, this.published);
			await this.opts.saveSnapshot(serializeSnapshot(snap));
		} catch (e) {
			console.warn(`[Realtime] failed to persist snapshot for ${this.docId}`, e);
		}
	}

	// --- escape hatch ----------------------------------------------------------

	private rebasing = false;

	/** Discard local DB + snapshot and rebuild from the server replica. */
	async rebaseFromServer(): Promise<void> {
		if (this.closed || !this.sqlite || this.rebasing) return;
		this.rebasing = true;
		try {
			await this.doRebase();
		} finally {
			this.rebasing = false;
		}
	}

	private async doRebase(): Promise<void> {
		this.setState("bootstrapping");
		await this.opts.deleteSnapshot().catch(() => {});
		await this.resetDb();
		await this.runMigrate(0);
		await this.bootstrapFromServer();
		// Re-apply the log on top of the fresh bootstrap.
		this.appliedBatchIds.clear();
		await this.enqueueApply(this.sync?.listBatches() ?? []);
		await this.publishNow();
		if (this._state !== "needs-migration") this.setState("live");
		this.scheduleSnapshot();
	}

	// --- delete / restore ------------------------------------------------------

	/** Soft-delete: set the doc tombstone (the trash entry is recorded by VaultSync). */
	markDeleted(): void {
		this.sync?.setDeletedAt(Date.now());
	}

	/** Clear the tombstone so a fresh open() re-bootstraps. */
	clearDeleted(): void {
		this.sync?.clearDeletedAt();
	}

	isLive(): boolean {
		return !!this.sync && this.sync.getDeletedAt() === null;
	}

	// --- teardown --------------------------------------------------------------

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.publishTimer) clearTimeout(this.publishTimer);
		if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
		this.unobserveBatches?.();
		this.unobserveMeta?.();
		try {
			await this.persistSnapshot();
		} catch {
			/* best effort */
		}
		if (this.db) await this.db.close().catch(() => {});
		this.db = null;
		// Let any just-written updates (final batches, the delete tombstone)
		// reach the server before tearing the transport down.
		await this.sync?.whenFlushed().catch(() => {});
		this.sync?.destroy();
		this.sync = null;
		this.setState("offline");
	}
}

class WasmError extends Error {}

export class DeletedError extends Error {
	readonly reason = "deleted" as const;
	constructor(pluginId: string, name: string) {
		super(`database ${pluginId}/${name} was deleted`);
	}
}

/** Lexicographically-sortable-ish unique id (timestamp + random). */
function makeBatchId(): string {
	const t = Date.now().toString(36).padStart(9, "0");
	const r = Math.random().toString(36).slice(2, 10);
	return `${t}-${r}`;
}

/** Build a bare in-memory doc handle (tests / offline use). */
export function makeMemoryDocHandle(doc: Y.Doc): PluginDbDocHandle {
	return {
		doc,
		whenSynced: Promise.resolve(),
		isConnected: () => true,
		onStatus: () => () => {},
		destroy: () => {},
	};
}
