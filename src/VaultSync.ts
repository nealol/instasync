import * as Y from "yjs";
import {
	YSweetProvider,
	STATUS_CONNECTED,
	STATUS_OFFLINE,
	STATUS_ERROR,
	EVENT_CONNECTION_STATUS,
	type YSweetStatus,
} from "@y-sweet/client";
import { IndexeddbPersistence } from "y-indexeddb";
import { TFile, TAbstractFile, Notice } from "obsidian";
import type InstaSyncPlugin from "./main";
import { getClientToken } from "./ysweet";
import { Document } from "./Document";

/** Matches the sibling backups written on conflict; these must never sync. */
const CONFLICT_COPY_RE = / \(conflicted copy .+\)$/;

/** True for files like "Note (conflicted copy Brave Otter 2026-06-02 154233).md". */
export function isConflictCopy(path: string): boolean {
	const dot = path.lastIndexOf(".");
	const base = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
	return CONFLICT_COPY_RE.test(base);
}

function newGuid(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return crypto.randomUUID();
	}
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

/**
 * Coordinates collaborative sync for the whole vault:
 *  - maintains a shared "file index" (path -> doc guid) in its own Y.Doc, so
 *    file creations/deletions propagate between clients;
 *  - owns a {@link Document} per Markdown file.
 *
 * One vault maps to one y-sweet server (configured by URL + vault id).
 */
export class VaultSync {
	private plugin: InstaSyncPlugin;
	private indexDoc: Y.Doc;
	private indexProvider: YSweetProvider;
	private indexPersistence: IndexeddbPersistence;
	/** Shared map of vault-relative path -> document guid. */
	private files: Y.Map<string>;

	private documents = new Map<string, Document>();
	private destroyed = false;
	private initialSynced = false;

	private filesObserver: (event: Y.YMapEvent<string>) => void;
	private statusListener: (status: YSweetStatus) => void;

	constructor(plugin: InstaSyncPlugin) {
		this.plugin = plugin;

		this.indexDoc = new Y.Doc();
		this.files = this.indexDoc.getMap("files");

		const vaultId = plugin.settings.activeVaultId;

		// Connect only after the persisted index has loaded (see init()), so local
		// offline map changes merge with the server instead of racing it. The index
		// doc keeps the bare vault id; file docs are namespaced as `${vaultId}__${guid}`.
		this.indexProvider = new YSweetProvider(
			() => getClientToken(plugin, vaultId),
			vaultId,
			this.indexDoc,
			{ connect: false, showDebuggerLink: false },
		);
		this.indexPersistence = new IndexeddbPersistence(vaultId, this.indexDoc);

		this.filesObserver = this.onFilesChanged.bind(this);
		this.files.observe(this.filesObserver);

		this.statusListener = (status) => {
			if (status === STATUS_CONNECTED) {
				this.plugin.setStatus("connected");
				void this.runInitialSync();
			} else if (status === "connecting" || status === "handshaking") {
				this.plugin.setStatus("connecting");
			} else if (status === "error") {
				this.plugin.setStatus("error");
			}
		};
		this.indexProvider.on(EVENT_CONNECTION_STATUS, this.statusListener);

		this.registerVaultEvents();
		void this.init();
	}

	/** Load the persisted index, then connect so local offline changes sync. */
	private async init(): Promise<void> {
		try {
			await this.indexPersistence.whenSynced;
		} catch (e) {
			console.error("[InstaSync] index persistence failed to load", e);
		}
		if (this.destroyed) return;
		void this.indexProvider.connect();
	}

	/** Nudge the index provider and every document to reconnect if stalled. */
	reconnectAll(): void {
		if (this.destroyed) return;
		const status = this.indexProvider.status;
		if (status === STATUS_OFFLINE || status === STATUS_ERROR) {
			void this.indexProvider.connect();
		}
		for (const doc of this.documents.values()) doc.ensureConnected();
	}

	// --- Index synchronisation -------------------------------------------------

	private async runInitialSync(): Promise<void> {
		if (this.initialSynced || this.destroyed) return;
		this.initialSynced = true;

		// Connect documents for entries that already exist in the shared index.
		for (const [path, guid] of this.files.entries()) {
			this.ensureDocument(path, guid, false);
		}

		// Add any local Markdown files that aren't tracked yet.
		const mdFiles = this.plugin.app.vault.getMarkdownFiles();
		for (const file of mdFiles) {
			if (isConflictCopy(file.path)) continue;
			if (!this.files.has(file.path)) {
				const guid = newGuid();
				this.indexDoc.transact(() => {
					this.files.set(file.path, guid);
				});
				this.registerFile(file.path, guid);
				this.ensureDocument(file.path, guid, true);
			} else {
				this.ensureDocument(file.path, this.files.get(file.path)!, false);
			}
		}

		new Notice(`InstaSync: connected, syncing ${this.documents.size} files.`);
	}

	private onFilesChanged(event: Y.YMapEvent<string>): void {
		if (this.destroyed) return;
		event.changes.keys.forEach((change, path) => {
			if (change.action === "add" || change.action === "update") {
				const guid = this.files.get(path);
				if (guid) this.ensureDocument(path, guid, false);
			} else if (change.action === "delete") {
				this.handleRemoteDelete(path);
			}
		});
	}

	private async handleRemoteDelete(path: string): Promise<void> {
		this.removeDocument(path);
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			try {
				await this.plugin.app.vault.delete(file);
			} catch (e) {
				console.error(`[InstaSync] failed to delete ${path}`, e);
			}
		}
	}

	// --- Document registry -----------------------------------------------------

	private ensureDocument(path: string, guid: string, isCreator: boolean): Document {
		const existing = this.documents.get(path);
		if (existing && existing.guid === guid) return existing;
		if (existing) this.removeDocument(path);

		const serverDocId = `${this.plugin.settings.activeVaultId}__${guid}`;
		const doc = new Document(this.plugin, path, guid, serverDocId, isCreator);
		this.documents.set(path, doc);
		this.plugin.applyAwarenessTo(doc);
		return doc;
	}

	/** Best-effort: keep the server's guid → path registry current (for ACLs). */
	private registerFile(path: string, guid: string): void {
		void this.plugin.auth.registerFile(this.plugin.settings.activeVaultId, guid, path);
	}

	private removeDocument(path: string): void {
		const doc = this.documents.get(path);
		if (doc) {
			doc.destroy();
			this.documents.delete(path);
		}
	}

	getDocumentForPath(path: string): Document | undefined {
		return this.documents.get(path);
	}

	allDocuments(): Document[] {
		return Array.from(this.documents.values());
	}

	// --- Local vault events ----------------------------------------------------

	private registerVaultEvents(): void {
		const vault = this.plugin.app.vault;

		this.plugin.registerEvent(
			vault.on("create", (file) => this.onLocalCreate(file)),
		);
		this.plugin.registerEvent(
			vault.on("delete", (file) => this.onLocalDelete(file)),
		);
		this.plugin.registerEvent(
			vault.on("rename", (file, oldPath) => this.onLocalRename(file, oldPath)),
		);
		this.plugin.registerEvent(
			vault.on("modify", (file) => this.onLocalModify(file)),
		);
	}

	private isSyncable(file: TAbstractFile): file is TFile {
		return file instanceof TFile && file.extension === "md";
	}

	private onLocalCreate(file: TAbstractFile): void {
		if (!this.initialSynced || !this.isSyncable(file)) return;
		if (isConflictCopy(file.path)) return;
		if (this.files.has(file.path)) {
			// Created locally because a remote entry arrived; Document handles it.
			this.ensureDocument(file.path, this.files.get(file.path)!, false);
			return;
		}
		const guid = newGuid();
		this.indexDoc.transact(() => {
			this.files.set(file.path, guid);
		});
		this.registerFile(file.path, guid);
		this.ensureDocument(file.path, guid, true);
	}

	private onLocalDelete(file: TAbstractFile): void {
		if (!this.initialSynced) return;
		const path = file.path;
		if (!this.documents.has(path) && !this.files.has(path)) return;
		this.removeDocument(path);
		if (this.files.has(path)) {
			this.indexDoc.transact(() => {
				this.files.delete(path);
			});
		}
	}

	private onLocalRename(file: TAbstractFile, oldPath: string): void {
		if (!this.initialSynced || !(file instanceof TFile)) return;
		const newPath = file.path;

		// Drop tracking of the old path.
		const wasTracked = this.files.has(oldPath);
		const guid = this.files.get(oldPath) ?? this.documents.get(oldPath)?.guid;
		this.removeDocument(oldPath);

		if (file.extension !== "md") {
			// Renamed out of Markdown; stop syncing it.
			if (wasTracked) {
				this.indexDoc.transact(() => this.files.delete(oldPath));
			}
			return;
		}

		const finalGuid = guid ?? newGuid();
		this.indexDoc.transact(() => {
			if (wasTracked) this.files.delete(oldPath);
			this.files.set(newPath, finalGuid);
		});
		this.registerFile(newPath, finalGuid);
		this.ensureDocument(newPath, finalGuid, !wasTracked);
	}

	private onLocalModify(file: TAbstractFile): void {
		if (!this.initialSynced || !this.isSyncable(file)) return;
		const doc = this.documents.get(file.path);
		if (doc) void doc.onDiskChanged();
	}

	// --- Lifecycle -------------------------------------------------------------

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.files.unobserve(this.filesObserver);
		this.indexProvider.off(EVENT_CONNECTION_STATUS, this.statusListener);
		for (const doc of this.documents.values()) doc.destroy();
		this.documents.clear();
		this.indexProvider.destroy();
		void this.indexPersistence.destroy();
		this.indexDoc.destroy();
	}
}
