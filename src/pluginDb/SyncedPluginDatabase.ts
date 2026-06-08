import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { EVENT_CONNECTION_STATUS, STATUS_CONNECTED, STATUS_ERROR, STATUS_OFFLINE, YSweetProvider } from "@y-sweet/client";
import type RealtimePlugin from "../main";
import { getClientToken } from "../ysweet";
import { decodeSqlValue, encodeSqlValue, openCrsqliteDatabase } from "./crsqlite";
import type { CrSqliteChangeRow, EncodedSqlValue, OpenSyncedDatabaseOptions, PluginDbChangeBatch, PluginDbCheckpointStore, SqlDatabaseAdapter, SyncedDatabase, SyncedDatabaseStatus, SyncedPluginDatabaseDeps } from "./types";

const RETAIN_BATCHES = 1000;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const CHECKPOINT_FORMAT = 1;

interface PluginDbCheckpoint {
	format: number;
	cursors: Record<string, number>;
	tables: Array<{ name: string; columns: string[]; rows: EncodedSqlValue[][] }>;
}

export class SyncedPluginDatabase implements SyncedDatabase {
	readonly ydoc: Y.Doc;
	private readonly batches: Y.Array<PluginDbChangeBatch>;
	private readonly cursors: Y.Map<Record<string, number>>;
	private readonly meta: Y.Map<unknown>;
	private readonly provider: YSweetProvider | undefined;
	private readonly persistence: IndexeddbPersistence | { whenSynced?: Promise<void>; destroy?: () => unknown } | undefined;
	private db!: SqlDatabaseAdapter;
	private status: SyncedDatabaseStatus = "opening";
	private listeners = new Set<(status: SyncedDatabaseStatus) => void>();
	private localSiteId = "";
	private lastPublishedDbVersion = 0;
	private appliedBatchIds = new Set<string>();
	private destroyed = false;
	private publishTimer: number | null = null;
	private observer: () => void;
	private statusListener: (status: string) => void;
	private initPromise: Promise<void>;
	private readonly checkpointStore: PluginDbCheckpointStore | undefined;
	private checkpointCursors: Record<string, number> = {};

	constructor(
		private readonly plugin: RealtimePlugin,
		private readonly serverDocId: string,
		private readonly localName: string,
		private readonly options: OpenSyncedDatabaseOptions,
		deps: SyncedPluginDatabaseDeps = {},
	) {
		this.checkpointStore = deps.checkpointStore ?? makeAdapterCheckpointStore(plugin);
		const made = deps.makeDoc?.(serverDocId);
		this.ydoc = made?.ydoc ?? new Y.Doc();
		this.persistence = made ? made.persistence : new IndexeddbPersistence(serverDocId, this.ydoc);
		this.provider = made ? made.provider : new YSweetProvider(() => getClientToken(plugin, serverDocId), serverDocId, this.ydoc, { connect: false, showDebuggerLink: false });
		this.batches = this.ydoc.getArray("batches");
		this.cursors = this.ydoc.getMap("cursors");
		this.meta = this.ydoc.getMap("meta");
		this.observer = () => void this.applyRemoteBatches();
		this.statusListener = (status) => {
			if (status === STATUS_CONNECTED) this.setStatus("syncing");
			else if (status === STATUS_ERROR) this.setStatus("error");
			else if (status === STATUS_OFFLINE) this.setStatus("offline");
		};
		this.batches.observe(this.observer);
		this.provider?.on?.(EVENT_CONNECTION_STATUS, this.statusListener);
		this.initPromise = this.init(deps.openSqliteDatabase ?? openCrsqliteDatabase);
	}

	async whenReady(): Promise<void> { await this.initPromise; }

	async exec(sql: string, params?: unknown[]): Promise<void> {
		await this.whenReady();
		await this.db.exec(sql, params);
		await this.publishLocalChanges();
	}

	async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
		await this.whenReady();
		await this.applyRemoteBatches();
		return this.db.query<T>(sql, params);
	}

	async transaction<T>(fn: (db: SyncedDatabase) => Promise<T>): Promise<T> {
		await this.whenReady();
		const result = await this.db.transaction(() => fn(this));
		await this.publishLocalChanges();
		return result;
	}

	onStatus(cb: (status: SyncedDatabaseStatus) => void): () => void {
		this.listeners.add(cb);
		cb(this.status);
		return () => this.listeners.delete(cb);
	}

	ensureConnected(): void {
		if (this.destroyed) return;
		const status = this.provider?.status;
		if (status === STATUS_OFFLINE || status === STATUS_ERROR) void this.provider?.connect?.();
	}

	async close(): Promise<void> {
		if (this.destroyed) return;
		this.destroyed = true;
		if (this.publishTimer !== null) window.clearTimeout(this.publishTimer);
		this.batches.unobserve(this.observer);
		this.provider?.off?.(EVENT_CONNECTION_STATUS, this.statusListener);
		this.provider?.destroy?.();
		await this.persistence?.destroy?.();
		this.ydoc.destroy();
		await this.db?.close?.();
	}

	async deleteDatabase(): Promise<void> {
		await this.whenReady();
		if (this.publishTimer !== null) {
			window.clearTimeout(this.publishTimer);
			this.publishTimer = null;
		}
		this.ydoc.transact(() => {
			if (this.batches.length) this.batches.delete(0, this.batches.length);
			for (const key of Array.from(this.cursors.keys())) this.cursors.delete(key);
			for (const key of Array.from(this.meta.keys())) this.meta.delete(key);
			this.meta.set("format", 1);
			this.meta.set("deletedAt", Date.now());
		});
		await this.deleteCheckpoint();
		await this.close();
	}

	private async init(open: (name: string) => Promise<SqlDatabaseAdapter>): Promise<void> {
		try {
			await this.persistence?.whenSynced;
			if (this.destroyed) return;
			this.db = await open(this.localName);
			await this.options.schema?.(this.schemaFacade());
			await this.restoreCheckpoint();
			this.localSiteId = await this.readSiteId();
			this.lastPublishedDbVersion = await this.readPublishedCursor();
			await this.applyRemoteBatches();
			this.provider?.connect?.();
			await this.publishLocalChanges();
			await this.saveCheckpoint();
			this.setStatus("synced");
		} catch (e) {
			console.error(`[Realtime] plugin DB failed to open: ${this.serverDocId}`, e);
			this.setStatus("error");
			throw e;
		}
	}

	private schemaFacade(): SyncedDatabase {
		return {
			exec: (sql, params) => this.db.exec(sql, params),
			query: (sql, params) => this.db.query(sql, params),
			transaction: async (fn) => this.db.transaction(() => fn(this.schemaFacade())),
			close: () => this.close(),
			onStatus: (cb) => this.onStatus(cb),
		};
	}

	private setStatus(status: SyncedDatabaseStatus): void {
		if (this.status === status) return;
		this.status = status;
		for (const cb of this.listeners) cb(status);
	}

	private schedulePublish(): void {
		if (this.destroyed || this.publishTimer !== null) return;
		this.publishTimer = window.setTimeout(() => {
			this.publishTimer = null;
			void this.publishLocalChanges();
		}, 250);
	}

	private async readSiteId(): Promise<string> {
		const rows = await this.db.query<{ site_id: unknown }>("SELECT crsql_site_id() AS site_id");
		return valueToSiteString(rows[0]?.site_id);
	}

	private async readPublishedCursor(): Promise<number> {
		try {
			const rows = await this.db.query<{ value: number }>("SELECT value FROM crsql_master WHERE key = 'seq'");
			return Number(rows[0]?.value ?? 0);
		} catch {
			const rows = await this.db.query<{ db_version: number }>("SELECT COALESCE(MAX(db_version), 0) AS db_version FROM crsql_changes WHERE site_id = crsql_site_id()");
			return Number(rows[0]?.db_version ?? 0);
		}
	}

	private async publishLocalChanges(): Promise<void> {
		if (this.destroyed || !this.localSiteId) return;
		const changes = await this.readLocalChanges();
		if (!changes.length) return;
		const toDbVersion = Math.max(...changes.map((c) => c.dbVersion));
		const batch: PluginDbChangeBatch = {
			id: randomId(),
			siteId: this.localSiteId,
			fromDbVersion: this.lastPublishedDbVersion + 1,
			toDbVersion,
			changes,
			createdAt: Date.now(),
		};
		this.ydoc.transact(() => {
			this.batches.push([batch]);
			this.cursors.set(this.localSiteId, { ...(this.cursors.get(this.localSiteId) ?? {}), [this.localSiteId]: toDbVersion });
			this.meta.set("format", 1);
		});
		this.appliedBatchIds.add(batch.id);
		this.lastPublishedDbVersion = toDbVersion;
		this.compactBatches();
		await this.saveCheckpoint();
		this.setStatus("synced");
	}

	private async readLocalChanges(): Promise<CrSqliteChangeRow[]> {
		const rows = await this.db.query<any>(
			`SELECT "table", "pk", "cid", "val", "col_version", "db_version", "site_id", "cl", "seq"
			 FROM crsql_changes
			 WHERE db_version > ? AND site_id = crsql_site_id()
			 ORDER BY db_version, seq`,
			[this.lastPublishedDbVersion],
		);
		return rows.map((r) => ({
			table: String(r.table),
			pk: encodeSqlValue(r.pk),
			cid: String(r.cid),
			val: encodeSqlValue(r.val),
			colVersion: Number(r.col_version),
			dbVersion: Number(r.db_version),
			siteId: valueToSiteString(r.site_id),
			cl: Number(r.cl),
			seq: Number(r.seq),
		}));
	}

	private async applyRemoteBatches(): Promise<void> {
		if (this.destroyed || !this.db) return;
		const pending = this.batches.toArray().filter((b) => b.siteId !== this.localSiteId && !this.appliedBatchIds.has(b.id) && !this.isCoveredByCheckpoint(b));
		if (!pending.length) return;
		this.setStatus("syncing");
		for (const batch of pending) {
			this.appliedBatchIds.add(batch.id);
			await this.db.transaction(async () => {
				for (const c of batch.changes) {
					await this.db.exec(
						`INSERT INTO crsql_changes ("table", "pk", "cid", "val", "col_version", "db_version", "site_id", "cl", "seq") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						[c.table, decodeSqlValue(c.pk), c.cid, decodeSqlValue(c.val), c.colVersion, c.dbVersion, decodeSiteId(c.siteId), c.cl, c.seq],
					);
				}
			});
			this.cursors.set(this.localSiteId, { ...(this.cursors.get(this.localSiteId) ?? {}), [batch.siteId]: batch.toDbVersion });
		}
		this.compactBatches();
		await this.saveCheckpoint();
		this.setStatus("synced");
	}

	private isCoveredByCheckpoint(batch: PluginDbChangeBatch): boolean {
		return Number(this.checkpointCursors[batch.siteId] ?? 0) >= batch.toDbVersion;
	}

	private async restoreCheckpoint(): Promise<void> {
		const raw = await this.readCheckpointRaw();
		if (!raw) return;
		let checkpoint: PluginDbCheckpoint;
		try {
			checkpoint = JSON.parse(raw) as PluginDbCheckpoint;
		} catch (e) {
			console.warn(`[Realtime] plugin DB checkpoint is invalid: ${this.localName}`, e);
			return;
		}
		if (checkpoint.format !== CHECKPOINT_FORMAT || !Array.isArray(checkpoint.tables)) return;
		this.checkpointCursors = checkpoint.cursors ?? {};
		try {
			await this.db.transaction(async () => {
				for (const table of checkpoint.tables) {
					if (!isUserTable(table.name)) continue;
					const columns = table.columns.map(quoteIdent).join(", ");
					const placeholders = table.columns.map(() => "?").join(", ");
					for (const row of table.rows) {
						await this.db.exec(`INSERT OR REPLACE INTO ${quoteIdent(table.name)} (${columns}) VALUES (${placeholders})`, row.map(decodeSqlValue));
					}
				}
			});
		} catch (e) {
			this.checkpointCursors = {};
			console.warn(`[Realtime] failed to restore plugin DB checkpoint: ${this.localName}`, e);
		}
	}

	private async saveCheckpoint(): Promise<void> {
		if (!this.checkpointStore || !this.db || !this.localSiteId) return;
		try {
			const tables = await this.exportUserTables();
			const checkpoint: PluginDbCheckpoint = {
				format: CHECKPOINT_FORMAT,
				cursors: this.cursors.get(this.localSiteId) ?? {},
				tables,
			};
			this.checkpointCursors = checkpoint.cursors;
			await this.checkpointStore.write(this.checkpointPath(), JSON.stringify(checkpoint));
		} catch (e) {
			console.warn(`[Realtime] failed to save plugin DB checkpoint: ${this.localName}`, e);
		}
	}

	private async exportUserTables(): Promise<PluginDbCheckpoint["tables"]> {
		const rows = await this.db.query<{ name: string }>(
			`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
		);
		const out: PluginDbCheckpoint["tables"] = [];
		for (const { name } of rows) {
			const tableName = String(name);
			if (!isUserTable(tableName)) continue;
			const info = await this.db.query<{ name: string }>(`PRAGMA table_info(${quoteIdent(tableName)})`);
			const columns = info.map((c) => String(c.name));
			if (!columns.length) continue;
			const selected = columns.map(quoteIdent).join(", ");
			const tableRows = await this.db.query<Record<string, unknown>>(`SELECT ${selected} FROM ${quoteIdent(tableName)}`);
			out.push({
				name: tableName,
				columns,
				rows: tableRows.map((row) => columns.map((column) => encodeSqlValue(row[column]))),
			});
		}
		return out;
	}

	private async readCheckpointRaw(): Promise<string | null> {
		try {
			return await this.checkpointStore?.read(this.checkpointPath()) ?? null;
		} catch (e) {
			console.warn(`[Realtime] failed to read plugin DB checkpoint: ${this.localName}`, e);
			return null;
		}
	}

	private async deleteCheckpoint(): Promise<void> {
		try {
			await this.checkpointStore?.delete(this.checkpointPath());
		} catch (e) {
			console.warn(`[Realtime] failed to delete plugin DB checkpoint: ${this.localName}`, e);
		}
	}

	private checkpointPath(): string {
		const dir = this.plugin.manifest.dir ?? `.obsidian/plugins/${this.plugin.manifest.id}`;
		return `${dir}/plugin-db-checkpoints/${this.options.pluginId}/${this.options.name}.json`;
	}

	private compactBatches(): void {
		const all = this.batches.toArray();
		if (all.length <= RETAIN_BATCHES) return;
		const cutoff = Date.now() - RETAIN_MS;
		let remove = 0;
		for (let i = 0; i < all.length - RETAIN_BATCHES; i++) {
			if (all[i].createdAt > cutoff) break;
			remove++;
		}
		if (remove > 0) this.batches.delete(0, remove);
	}
}

function makeAdapterCheckpointStore(plugin: RealtimePlugin): PluginDbCheckpointStore | undefined {
	const adapter = plugin.app?.vault?.adapter as { read?: (path: string) => Promise<string>; write?: (path: string, data: string) => Promise<void>; remove?: (path: string) => Promise<void>; exists?: (path: string) => Promise<boolean>; mkdir?: (path: string) => Promise<void> } | undefined;
	if (!adapter?.read || !adapter.write) return undefined;
	return {
		read: async (path) => adapter.exists && !(await adapter.exists(path)) ? null : adapter.read!(path),
		write: async (path, data) => {
			const mkdir = adapter.mkdir;
			if (mkdir) await ensureParentDir({ exists: adapter.exists, mkdir }, path);
			await adapter.write!(path, data);
		},
		delete: async (path) => {
			if (adapter.exists && !(await adapter.exists(path))) return;
			await adapter.remove?.(path);
		},
	};
}

async function ensureParentDir(adapter: { exists?: (path: string) => Promise<boolean>; mkdir: (path: string) => Promise<void> }, path: string): Promise<void> {
	const parts = path.split("/").slice(0, -1);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		try {
			if (!adapter.exists || !(await adapter.exists(current))) await adapter.mkdir(current);
		} catch {
			// Directory may have been created concurrently.
		}
	}
}

function isUserTable(name: string): boolean {
	return !!name && !name.startsWith("sqlite_") && !name.startsWith("crsql_") && !name.startsWith("_crsql") && !name.includes("__crsql");
}

function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function randomId(): string {
	return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function valueToSiteString(value: unknown): string {
	if (value instanceof Uint8Array) return Array.from(value).map((b) => b.toString(16).padStart(2, "0")).join("");
	if (value instanceof ArrayBuffer) return valueToSiteString(new Uint8Array(value));
	return String(value ?? "");
}

function decodeSiteId(value: string): unknown {
	if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) {
		const out = new Uint8Array(value.length / 2);
		for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
		return out;
	}
	return value;
}
