import * as Y from "yjs";
import type RealtimePlugin from "./main";
import { sha256Hex } from "./hash";
import { matchesConfigGlobs } from "./glob";
import { dbg } from "./debug";

export interface ConfigMeta {
	hash: string;
	size: number;
	mtime: number;
}

const POLL_MS = 15_000;
const RETRY_MS = 2_000;

export class ConfigSync {
	private plugin: RealtimePlugin;
	private indexDoc: Y.Doc;
	private configFiles: Y.Map<ConfigMeta>;
	private globs: string[] = [];
	private lastSyncedHash = new Map<string, string>();
	private chains = new Map<string, Promise<void>>();
	private writing = new Set<string>();
	private pollTimer: number | null = null;
	private started = false;
	private destroyed = false;
	private observer: (event: Y.YMapEvent<ConfigMeta>) => void;
	private focusHandler = () => void this.reconcileAll();

	constructor(plugin: RealtimePlugin, indexDoc: Y.Doc) {
		this.plugin = plugin;
		this.indexDoc = indexDoc;
		this.configFiles = indexDoc.getMap<ConfigMeta>("configFiles");
		this.observer = this.onConfigFilesChanged.bind(this);
		this.configFiles.observe(this.observer);
	}

	private get vaultId(): string {
		return this.plugin.settings.activeVaultId;
	}

	/** Obsidian's config directory (user-configurable; usually `.obsidian`). */
	private get configRoot(): string {
		return this.plugin.app.vault.configDir;
	}

	/** The plugin's own folder, always excluded to avoid sync feedback loops. */
	private get hardExcludeDir(): string {
		return `${this.configRoot}/plugins/realtime`;
	}

	seedBaseline(): void {
		for (const [path, meta] of this.configFiles.entries()) {
			if (meta?.hash) this.lastSyncedHash.set(path, meta.hash);
		}
		dbg("ConfigSync seedBaseline", this.lastSyncedHash.size, "entries");
	}

	start(globs: string[]): void {
		if (this.destroyed) return;
		this.globs = globs.map((glob) => glob.trim()).filter(Boolean);
		if (this.started) {
			void this.reconcileAll();
			return;
		}
		this.started = true;
		window.addEventListener("focus", this.focusHandler);
		void this.reconcileAll();
		this.schedulePoll();
	}

	async reconcileAll(): Promise<void> {
		if (this.destroyed || !this.started) return;
		const paths = new Set<string>();
		for (const path of this.configFiles.keys()) {
			if (!this.isHardExcluded(path)) paths.add(path);
		}
		for (const path of await this.localConfigPaths()) paths.add(path);
		for (const path of paths) {
			await this.reconcile(path);
			if (this.destroyed) return;
		}
	}

	private onConfigFilesChanged(event: Y.YMapEvent<ConfigMeta>): void {
		if (this.destroyed || !this.started) return;
		event.changes.keys.forEach((_change, path) => {
			if (!this.isHardExcluded(path)) void this.reconcile(path);
		});
	}

	private reconcile(path: string): Promise<void> {
		if (this.isHardExcluded(path) || !this.matchesGlobs(path)) return Promise.resolve();
		if (this.writing.has(path)) return Promise.resolve();
		const prev = this.chains.get(path) ?? Promise.resolve();
		const next = prev.then(() => this.reconcileNow(path)).catch((e) => {
			console.error(`[Realtime] config reconcile failed for ${path}`, e);
		});
		this.chains.set(path, next);
		void next.finally(() => {
			if (this.chains.get(path) === next) this.chains.delete(path);
		});
		return next;
	}

	private async reconcileNow(path: string): Promise<void> {
		if (this.destroyed) return;
		const local = await this.localInfo(path);
		if (local === undefined || this.destroyed) return;
		const remote = this.configFiles.get(path) ?? null;
		const localHash = local?.hash ?? null;
		const remoteHash = remote?.hash ?? null;
		const base = this.lastSyncedHash.get(path) ?? null;

		if (localHash === remoteHash) {
			if (remoteHash) this.lastSyncedHash.set(path, remoteHash);
			else this.lastSyncedHash.delete(path);
			return;
		}

		if (local && !remote) {
			if (base === null) await this.upload(path, local);
			else if (base === local.hash) await this.deleteLocal(path);
			else await this.upload(path, local);
			return;
		}

		if (!local && remote) {
			if (base === remote.hash) this.publishDelete(path);
			else await this.download(path, remote);
			return;
		}

		if (local && remote) {
			if (base === remote.hash) await this.upload(path, local);
			else if (base === local.hash) await this.download(path, remote);
			else if (local.mtime >= remote.mtime) await this.upload(path, local);
			else await this.download(path, remote);
		}
	}

	private async localConfigPaths(): Promise<string[]> {
		const paths: string[] = [];
		await this.walk(this.configRoot, paths);
		return paths.filter((path) => !this.isHardExcluded(path) && this.matchesGlobs(path));
	}

	private async walk(folder: string, paths: string[]): Promise<void> {
		let listed: { files: string[]; folders: string[] };
		try {
			listed = await this.plugin.app.vault.adapter.list(folder);
		} catch {
			return;
		}
		for (const file of listed.files) paths.push(file);
		for (const child of listed.folders) {
			if (this.isHardExcluded(child)) continue;
			await this.walk(child, paths);
		}
	}

	private async localInfo(path: string): Promise<ConfigMeta | null | undefined> {
		try {
			if (!(await this.plugin.app.vault.adapter.exists(path))) return null;
			const bytes = await this.plugin.app.vault.adapter.readBinary(path);
			const stat = await this.plugin.app.vault.adapter.stat(path);
			return { hash: await sha256Hex(bytes), size: bytes.byteLength, mtime: stat?.mtime ?? Date.now() };
		} catch (e) {
			console.error(`[Realtime] failed to read config ${path}`, e);
			return undefined;
		}
	}

	private async upload(path: string, meta: ConfigMeta): Promise<void> {
		const bytes = await this.plugin.app.vault.adapter.readBinary(path);
		const hash = await sha256Hex(bytes);
		if (this.destroyed) return;
		const finalMeta = hash === meta.hash ? meta : { hash, size: bytes.byteLength, mtime: Date.now() };
		if (!(await this.plugin.auth.blobExists(this.vaultId, finalMeta.hash))) {
			await this.plugin.auth.putBlob(this.vaultId, finalMeta.hash, bytes);
		}
		if (this.destroyed) return;
		this.indexDoc.transact(() => this.configFiles.set(path, finalMeta));
		this.lastSyncedHash.set(path, finalMeta.hash);
		dbg("config uploaded+published", path, finalMeta.hash, finalMeta.size);
	}

	private async download(path: string, meta: ConfigMeta): Promise<void> {
		let bytes: ArrayBuffer;
		try {
			bytes = await this.plugin.auth.getBlob(this.vaultId, meta.hash);
		} catch (e) {
			if (this.destroyed) return;
			console.error(`[Realtime] config blob download failed for ${path}`, e);
			window.setTimeout(() => void this.reconcile(path), RETRY_MS);
			return;
		}
		if (this.destroyed) return;
		this.writing.add(path);
		try {
			await this.ensureParentFolders(path);
			await this.plugin.app.vault.adapter.writeBinary(path, bytes);
			this.lastSyncedHash.set(path, meta.hash);
			dbg("config downloaded", path, meta.hash, bytes.byteLength);
		} finally {
			window.setTimeout(() => this.writing.delete(path), 0);
		}
	}

	private async deleteLocal(path: string): Promise<void> {
		this.writing.add(path);
		try {
			if (await this.plugin.app.vault.adapter.exists(path)) {
				await this.plugin.app.vault.adapter.remove(path);
			}
			this.lastSyncedHash.delete(path);
		} finally {
			window.setTimeout(() => this.writing.delete(path), 0);
		}
	}

	private publishDelete(path: string): void {
		this.indexDoc.transact(() => this.configFiles.delete(path));
		this.lastSyncedHash.delete(path);
	}

	private async ensureParentFolders(path: string): Promise<void> {
		const parts = path.split("/").slice(0, -1);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.plugin.app.vault.adapter.exists(current))) {
				await this.plugin.app.vault.adapter.mkdir(current);
			}
		}
	}

	private schedulePoll(): void {
		if (this.destroyed || this.pollTimer !== null) return;
		this.pollTimer = window.setTimeout(() => {
			this.pollTimer = null;
			void this.reconcileAll().finally(() => this.schedulePoll());
		}, POLL_MS);
	}

	private matchesGlobs(path: string): boolean {
		return matchesConfigGlobs(path, this.configRoot, this.globs);
	}

	private isHardExcluded(path: string): boolean {
		const dir = this.hardExcludeDir;
		return path === dir || path.startsWith(`${dir}/`) || path.split("/").includes("node_modules");
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.started = false;
		this.configFiles.unobserve(this.observer);
		window.removeEventListener("focus", this.focusHandler);
		if (this.pollTimer !== null) {
			window.clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
		this.chains.clear();
	}
}
