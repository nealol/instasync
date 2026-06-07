import * as Y from "yjs";
import { Notice, normalizePath, TFile } from "obsidian";
import type RealtimePlugin from "./main";
import { SyncedDoc } from "./SyncedDoc";
import { ensureParentFolder, getFileByPath, isOpenInWorkspace } from "./vaultHelpers";
import { reconcileInto, toValue, type JsonValue } from "./structured/reconcile";

const DISK_ORIGIN = Symbol("realtime-structured-disk");

export abstract class StructuredDocument extends SyncedDoc {
	readonly root: Y.Map<any>;
	private rootObserver: (events: Array<Y.YEvent<any>>, txn: Y.Transaction) => void;
	private writingToDisk = false;
	private writeTimer: number | null = null;
	private startupReconciled = false;
	private baselineAtStartup = "";
	private diskAtStartup: JsonValue | null = null;
	private localChangedAtStartup = false;

	protected constructor(
		plugin: RealtimePlugin,
		path: string,
		guid: string,
		serverDocId: string,
		isCreator: boolean,
	) {
		super(plugin, path, guid, serverDocId, isCreator);
		this.root = this.ydoc.getMap("root");
		this.rootObserver = (_events, txn) => this.onRootChanged(txn?.origin);
		this.root.observeDeep(this.rootObserver);
	}

	get value(): JsonValue {
		return toValue(this.root);
	}

	protected abstract parse(text: string): JsonValue;
	protected abstract serialize(value: JsonValue): string;

	protected async afterPersistenceSynced(): Promise<void> {
		this.baselineAtStartup = this.serialize(this.value);
		const disk = await this.readParsedFromDisk();
		this.diskAtStartup = disk;
		this.localChangedAtStartup = disk !== null && this.serialize(disk) !== this.baselineAtStartup;
	}

	protected async finishStartupReconcile(): Promise<void> {
		if (this.startupReconciled || this.destroyed) return;
		this.startupReconciled = true;
		try {
			if (this.localChangedAtStartup && this.diskAtStartup !== null) {
				this.applyValue(this.diskAtStartup, DISK_ORIGIN);
			}
			if (!this.isOpen()) await this.writeToDisk(this.serialize(this.value));
		} catch (e) {
			console.error(`[Realtime] structured startup reconcile failed for ${this.path}`, e);
		} finally {
			this.resolveWhenReady();
		}
	}

	async onDiskChanged(): Promise<void> {
		if (this.destroyed || this.writingToDisk || this.isOpen()) return;
		const disk = await this.readParsedFromDisk();
		if (disk === null) return;
		if (this.serialize(disk) === this.serialize(this.value)) return;
		this.plugin.vaultSync?.noteTextActivity();
		this.applyValue(disk, DISK_ORIGIN);
	}

	protected applyValue(value: JsonValue, origin: unknown = DISK_ORIGIN): void {
		this.ydoc.transact(() => reconcileInto(this.root, value), origin);
	}

	protected onRootChanged(_origin?: unknown): void {
		if (this.destroyed) return;
		this.plugin.vaultSync?.noteTextActivity();
		if (this.isOpen()) return;
		this.scheduleWriteToDisk();
	}

	private scheduleWriteToDisk(): void {
		if (this.writeTimer !== null) window.clearTimeout(this.writeTimer);
		this.writeTimer = window.setTimeout(() => {
			this.writeTimer = null;
			if (this.destroyed || this.isOpen()) return;
			void this.writeToDisk(this.serialize(this.value));
		}, 100);
	}

	protected getFile(): TFile | null {
		return getFileByPath(this.plugin.app, this.path);
	}

	protected isOpen(): boolean {
		return isOpenInWorkspace(this.plugin.app, this.path);
	}

	private async readParsedFromDisk(): Promise<JsonValue | null> {
		const file = this.getFile();
		if (!file) return null;
		try {
			return this.parse(await this.plugin.app.vault.read(file));
		} catch (e) {
			console.error(`[Realtime] failed to parse ${this.path}`, e);
			new Notice(`Realtime: could not parse ${this.path}; keeping the last synced version.`);
			return null;
		}
	}

	protected async writeToDisk(text: string): Promise<void> {
		if (this.destroyed) return;
		this.writingToDisk = true;
		try {
			const file = this.getFile();
			if (file) {
				if (this.isOpen()) return;
				if ((await this.plugin.app.vault.read(file)) === text) return;
				await this.plugin.app.vault.modify(file, text);
			} else {
				const path = normalizePath(this.path);
				await ensureParentFolder(this.plugin.app, path);
				await this.plugin.app.vault.create(path, text);
			}
		} catch (e) {
			console.error(`[Realtime] structured writeToDisk failed for ${this.path}`, e);
		} finally {
			window.setTimeout(() => {
				this.writingToDisk = false;
			}, 0);
		}
	}

	protected destroySubclass(): void {
		if (this.writeTimer !== null) {
			window.clearTimeout(this.writeTimer);
			this.writeTimer = null;
		}
		this.root.unobserveDeep(this.rootObserver);
	}
}
