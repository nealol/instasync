/**
 * Public, plugin-author-facing entry point for the synced-SQLite API,
 * reachable as `app.plugins.plugins["realtime"].sql`.
 *
 * See docs/plugin-sql for the full guide. The API is intentionally small:
 * `open`, `delete`, `restore`, `whenAvailable`, plus the returned database
 * handle.
 */

import type RealtimePlugin from "../main";
import { SyncedPluginDatabase, makeMemoryDocHandle, type MigrateFn, type SqlTx } from "./SyncedPluginDatabase";
import { PluginDbSync } from "./PluginDbSync";
import { buildEngineDeps } from "./obsidianDeps";
import type { DbState, RemoteChange, SqlValue } from "./types";
import { isValidId } from "./types";

export interface OpenOptions {
	name: string;
	pluginId: string;
	schemaVersion: number;
	migrate: MigrateFn;
	/** Optional repair hook run after each remote apply (dedupe etc.). */
	onMergeReview?: (tables: string[]) => void | Promise<void>;
}

export interface DeleteOrRestoreOptions {
	pluginId: string;
	name: string;
}

/** The database handle returned by {@link RealtimeSqlAPI.open}. */
export interface DatabaseHandle {
	exec(sql: string, bind?: SqlValue[]): Promise<void>;
	query<T = Record<string, SqlValue>>(sql: string, bind?: SqlValue[]): Promise<T[]>;
	transaction<T>(cb: (tx: SqlTx) => Promise<T>): Promise<T>;
	onRemoteChange(cb: (c: RemoteChange) => void): () => void;
	onStateChange(cb: (s: DbState) => void): () => void;
	readonly state: DbState;
	whenLive(): Promise<void>;
	rebaseFromServer(): Promise<void>;
	close(): Promise<void>;
}

export class RealtimeSqlAPI {
	private plugin: RealtimePlugin;
	private engines = new Map<string, SyncedPluginDatabase>();

	constructor(plugin: RealtimePlugin) {
		this.plugin = plugin;
	}

	/** Cancellers for pending whenAvailable() pollers (fired on destroy/abort). */
	private availabilityCancels = new Set<() => void>();

	/**
	 * Resolves once Realtime is enabled, signed in, and bound to a vault.
	 * Never resolves while the user stays signed out — pass an `AbortSignal`
	 * to stop waiting early. Plugin unload rejects all pending waiters.
	 */
	async whenAvailable(opts?: { signal?: AbortSignal }): Promise<void> {
		if (this.available()) return;
		if (opts?.signal?.aborted) throw new Error("whenAvailable aborted");
		await new Promise<void>((resolve, reject) => {
			const timer = setInterval(() => {
				if (this.available()) {
					cleanup();
					resolve();
				}
			}, 200);
			const cancel = () => {
				cleanup();
				reject(new Error("whenAvailable aborted"));
			};
			const cleanup = () => {
				clearInterval(timer);
				this.availabilityCancels.delete(cancel);
				opts?.signal?.removeEventListener("abort", cancel);
			};
			this.availabilityCancels.add(cancel);
			opts?.signal?.addEventListener("abort", cancel, { once: true });
		});
	}

	private available(): boolean {
		return (
			this.plugin.settings.enabled &&
			this.plugin.auth.isLoggedIn &&
			!!this.plugin.settings.activeVaultId
		);
	}

	private requireAvailable(): void {
		if (!this.plugin.settings.enabled) throw new Error("Realtime is disabled in settings.");
		if (!this.plugin.auth.isLoggedIn) throw new Error("Realtime is signed out — sign in first.");
		if (!this.plugin.settings.activeVaultId) throw new Error("Realtime has no active vault.");
	}

	private key(pluginId: string, name: string): string {
		return `${pluginId}__${name}`;
	}

	async open(opts: OpenOptions): Promise<DatabaseHandle> {
		validateIds(opts.pluginId, opts.name);
		if (!Number.isInteger(opts.schemaVersion) || opts.schemaVersion < 1) {
			throw new Error("schemaVersion must be a positive integer.");
		}
		this.requireAvailable();
		await layoutReady(this.plugin);

		const key = this.key(opts.pluginId, opts.name);
		let engine = this.engines.get(key);
		if (engine && engine.state === "error") {
			// A tombstoned/failed engine cannot be reused — rebuild from scratch
			// (e.g. the database was deleted and then restored from the trash on
			// another device; the fresh engine re-bootstraps).
			this.engines.delete(key);
			await engine.close().catch(() => {});
			engine = undefined;
		}
		if (!engine) {
			const deps = buildEngineDeps(this.plugin, opts.pluginId, opts.name);
			engine = new SyncedPluginDatabase({
				vaultId: this.plugin.settings.activeVaultId,
				pluginId: opts.pluginId,
				name: opts.name,
				schemaVersion: opts.schemaVersion,
				migrate: opts.migrate,
				onMergeReview: opts.onMergeReview,
				...deps,
			});
			this.engines.set(key, engine);
		}
		engine.refcount++;
		try {
			await engine.start();
			// Re-opened with a newer schema: migrate the running engine in place
			// and drain any batches buffered while it was behind.
			if (opts.schemaVersion > engine.currentSchemaVersion) {
				await engine.upgradeSchema(opts.schemaVersion, opts.migrate);
			}
		} catch (e) {
			engine.refcount--;
			if (engine.refcount <= 0) {
				this.engines.delete(key);
				await engine.close().catch(() => {});
			}
			throw e;
		}
		return this.makeHandle(key, engine);
	}

	private makeHandle(key: string, engine: SyncedPluginDatabase): DatabaseHandle {
		let closed = false;
		return {
			exec: (sql, bind) => engine.exec(sql, bind),
			query: (sql, bind) => engine.query(sql, bind),
			transaction: (cb) => engine.transaction(cb),
			onRemoteChange: (cb) => engine.onRemoteChange(cb),
			onStateChange: (cb) => engine.onStateChange(cb),
			get state() {
				return engine.state;
			},
			whenLive: () => engine.whenLive(),
			rebaseFromServer: () => engine.rebaseFromServer(),
			close: async () => {
				if (closed) return;
				closed = true;
				engine.refcount--;
				if (engine.refcount <= 0) {
					this.engines.delete(key);
					await engine.close();
				}
			},
		};
	}

	/** Soft-delete: tombstone the doc AND drop it into the vault trash bin. */
	async delete(opts: DeleteOrRestoreOptions): Promise<void> {
		validateIds(opts.pluginId, opts.name);
		this.requireAvailable();
		const key = this.key(opts.pluginId, opts.name);
		const engine = this.engines.get(key);
		if (engine) {
			engine.markDeleted();
			// Drop the (now tombstoned) engine so a later open() rebuilds fresh.
			this.engines.delete(key);
			await engine.close().catch(() => {});
		} else {
			await this.withTransientDoc(opts.pluginId, opts.name, (sync) => {
				sync.setDeletedAt(Date.now());
			});
		}
		this.plugin.vaultSync?.recordTrash({
			path: `${opts.pluginId}/${opts.name}`,
			kind: "plugindb",
			pluginId: opts.pluginId,
			name: opts.name,
		});
	}

	/** Clear the tombstone so a fresh open() re-bootstraps. */
	async restore(opts: DeleteOrRestoreOptions): Promise<void> {
		validateIds(opts.pluginId, opts.name);
		this.requireAvailable();
		const key = this.key(opts.pluginId, opts.name);
		const engine = this.engines.get(key);
		if (engine) {
			// The engine is likely in the terminal `deleted` error state; clear the
			// tombstone and drop it so the next open() re-bootstraps from scratch.
			engine.clearDeleted();
			this.engines.delete(key);
			await engine.close().catch(() => {});
			return;
		}
		await this.withTransientDoc(opts.pluginId, opts.name, (sync) => {
			sync.clearDeletedAt();
		});
	}

	/** True when a non-tombstoned database with this id currently exists. */
	async isLive(opts: DeleteOrRestoreOptions): Promise<boolean> {
		const key = this.key(opts.pluginId, opts.name);
		const engine = this.engines.get(key);
		if (engine) return engine.isLive();
		return this.withTransientDoc(opts.pluginId, opts.name, (sync) => {
			return sync.getDeletedAt() === null && (sync.listBatches().length > 0 || sync.getSchemaVersion() > 0);
		});
	}

	/** Open just the per-DB doc (no cr-sqlite) to read/flip meta, then tear down. */
	private async withTransientDoc<T>(
		pluginId: string,
		name: string,
		fn: (sync: PluginDbSync) => T,
	): Promise<T> {
		const vaultId = this.plugin.settings.activeVaultId;
		const docId = `${vaultId}__plugindb__${pluginId}__${name}`;
		const deps = buildEngineDeps(this.plugin, pluginId, name);
		const handle = deps.makeDoc(docId);
		const sync = new PluginDbSync(handle);
		try {
			await sync.whenSynced();
			return fn(sync);
		} finally {
			// Don't drop a just-written tombstone/restore with the connection.
			await sync.whenFlushed().catch(() => {});
			sync.destroy();
		}
	}

	/** Escape hatch: rebuild every currently-open database from the server replica. */
	async rebaseAll(): Promise<number> {
		const engines = [...this.engines.values()];
		for (const engine of engines) await engine.rebaseFromServer().catch(() => {});
		return engines.length;
	}

	/** Close every open database (plugin unload). */
	async destroy(): Promise<void> {
		for (const cancel of [...this.availabilityCancels]) cancel();
		this.availabilityCancels.clear();
		const engines = [...this.engines.values()];
		this.engines.clear();
		for (const engine of engines) await engine.close().catch(() => {});
	}
}

function validateIds(pluginId: string, name: string): void {
	if (!isValidId(pluginId)) {
		throw new Error(`pluginId must match [A-Za-z0-9_-]{1,80} without "__": ${pluginId}`);
	}
	if (!isValidId(name)) {
		throw new Error(`name must match [A-Za-z0-9_-]{1,80} without "__": ${name}`);
	}
}

function layoutReady(plugin: RealtimePlugin): Promise<void> {
	return new Promise<void>((resolve) => plugin.app.workspace.onLayoutReady(resolve));
}

// Re-export for the in-memory test harness and external typing.
export { makeMemoryDocHandle };
export type { MigrateFn, SqlTx };
