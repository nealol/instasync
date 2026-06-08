import type RealtimePlugin from "../main";
import type { OpenSyncedDatabaseOptions, SyncedDatabase, SyncedPluginDatabaseDeps } from "./types";
import { SyncedPluginDatabase } from "./SyncedPluginDatabase";

export const MAX_SAFE_ID_LENGTH = 80;

export function sanitizePluginDbId(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} is required`);
	if (trimmed.length > MAX_SAFE_ID_LENGTH) throw new Error(`${label} is too long`);
	if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) throw new Error(`${label} may only contain ASCII letters, numbers, dash, and underscore`);
	return trimmed;
}

export function pluginDbGuid(pluginId: string, name: string): string {
	return `plugindb__${sanitizePluginDbId(pluginId, "pluginId")}__${sanitizePluginDbId(name, "name")}`;
}

export function pluginDbDocId(vaultId: string, pluginId: string, name: string): string {
	return `${vaultId}__${pluginDbGuid(pluginId, name)}`;
}

export class PluginDbSync {
	private opened = new Map<string, SyncedPluginDatabase>();
	private destroyed = false;

	constructor(private readonly plugin: RealtimePlugin, private readonly deps: SyncedPluginDatabaseDeps = {}) {}

	async open(options: OpenSyncedDatabaseOptions): Promise<SyncedDatabase> {
		if (this.destroyed) throw new Error("plugin DB sync is stopped");
		const vaultId = this.plugin.settings.activeVaultId;
		if (!this.plugin.settings.enabled || !this.plugin.auth.isLoggedIn || !vaultId) throw new Error("Realtime sync must be enabled and signed in before opening a synced database");
		const safePluginId = sanitizePluginDbId(options.pluginId, "pluginId");
		const safeName = sanitizePluginDbId(options.name, "name");
		const guid = pluginDbGuid(safePluginId, safeName);
		const serverDocId = `${vaultId}__${guid}`;
		const key = `${safePluginId}/${safeName}`;
		const existing = this.opened.get(key);
		if (existing) return existing;
		await this.plugin.auth.registerFile(vaultId, guid, `.realtime/plugin-dbs/${safePluginId}/${safeName}`);
		const db = new SyncedPluginDatabase(this.plugin, serverDocId, `${vaultId}__plugindb__${safePluginId}__${safeName}`, { ...options, pluginId: safePluginId, name: safeName }, this.deps);
		this.opened.set(key, db);
		try {
			await db.whenReady();
		} catch (e) {
			this.opened.delete(key);
			await db.close().catch(() => {});
			throw e;
		}
		return db;
	}

	reconnectAll(): void {
		for (const db of this.opened.values()) db.ensureConnected();
	}

	destroy(): void {
		this.destroyed = true;
		for (const db of this.opened.values()) void db.close();
		this.opened.clear();
	}
}
