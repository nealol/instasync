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
import { TFile, TAbstractFile, Notice, type EventRef } from "obsidian";
import type RealtimePlugin from "./main";
import { getClientToken } from "./ysweet";
import { Document } from "./Document";
import { CanvasDocument } from "./CanvasDocument";
import { BaseDocument } from "./BaseDocument";
import type { StructuredDocument } from "./StructuredDocument";
import { BinarySync } from "./BinarySync";
import { ConfigSync } from "./ConfigSync";
import { matchesAnyGlob, parseGlobs } from "./glob";

type FileKind = "text" | "structured" | "binary" | "ignore";
type StructuredKind = "canvas" | "base";
interface StructuredMeta { guid: string; kind: StructuredKind }

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
	private plugin: RealtimePlugin;
	private indexDoc: Y.Doc;
	private indexProvider: YSweetProvider;
	private indexPersistence: IndexeddbPersistence;
	/** Shared map of vault-relative path -> document guid. */
	private files: Y.Map<string>;
	/** Shared map of vault-relative structured path -> document metadata. */
	private structured: Y.Map<StructuredMeta>;
	/** Sibling sync path for binary (non-Markdown) files; shares the index doc. */
	private binarySync: BinarySync;
	/** Per-device opt-in sync for whitelisted files under `.obsidian`. */
	private configSync: ConfigSync;

	private documents = new Map<string, Document>();
	private structuredDocuments = new Map<string, StructuredDocument>();
	private destroyed = false;
	private initialSynced = false;
	/** Last time a text document synced (ms epoch); gates background blob uploads. */
	private lastTextActivityAt = 0;
	/** Tracks the live connection so we only notify on a connected→dropped edge. */
	private wasConnected = false;

	private filesObserver: (event: Y.YMapEvent<string>) => void;
	private structuredObserver: (event: Y.YMapEvent<StructuredMeta>) => void;
	private statusListener: (status: YSweetStatus) => void;
	private vaultEvents: EventRef[] = [];

	constructor(plugin: RealtimePlugin) {
		this.plugin = plugin;

		this.indexDoc = new Y.Doc();
		this.files = this.indexDoc.getMap("files");
		this.structured = this.indexDoc.getMap("structured");
		this.binarySync = new BinarySync(plugin, this, this.indexDoc);
		this.configSync = new ConfigSync(plugin, this.indexDoc);

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
		this.structuredObserver = this.onStructuredChanged.bind(this);
		this.structured.observe(this.structuredObserver);

		this.statusListener = (status) => {
			if (status === STATUS_CONNECTED) {
				this.wasConnected = true;
				this.plugin.setStatus("connected");
				void this.runInitialSync();
			} else if (status === "connecting" || status === "handshaking") {
				this.notifyDisconnected();
				this.plugin.setStatus("connecting");
			} else if (status === "error") {
				this.notifyDisconnected();
				this.plugin.setStatus("error");
			} else {
				this.notifyDisconnected();
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
			console.error("[Realtime] index persistence failed to load", e);
		}
		if (this.destroyed) return;
		// Capture the persisted (pre-merge) binary baseline before connecting.
		this.binarySync.seedBaseline();
		this.configSync.seedBaseline();
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
		for (const doc of this.structuredDocuments.values()) doc.ensureConnected();
	}

	pathForGuid(guid: string): string | null {
		for (const [path, value] of this.files.entries()) {
			if (value === guid) return path;
		}
		for (const [path, meta] of this.structured.entries()) {
			if (meta.guid === guid) return path;
		}
		return null;
	}

	/** Notify once when a live connection drops; silent while already offline. */
	private notifyDisconnected(): void {
		if (!this.wasConnected) return;
		this.wasConnected = false;
		new Notice("Realtime: disconnected — reconnecting…");
	}

	// --- Index synchronisation -------------------------------------------------

	private async runInitialSync(): Promise<void> {
		if (this.initialSynced || this.destroyed) return;
		this.initialSynced = true;

		// Connect documents for entries that already exist in the shared index.
		for (const [path, guid] of this.files.entries()) {
			this.ensureDocument(path, guid, false);
		}
		for (const [path, meta] of this.structured.entries()) {
			this.ensureStructuredDocument(path, meta.guid, meta.kind, false);
		}

		// Add any local text or structured files that aren't tracked yet.
		const syncFiles = this.plugin.app.vault.getFiles().filter((file) => {
			const kind = this.classify(file);
			return kind === "text" || kind === "structured";
		});
		for (const file of syncFiles) {
			if (isConflictCopy(file.path)) continue;
			const kind = this.classify(file);
			if (kind === "structured") {
				const structuredKind = this.structuredKindForExtension(file.extension);
				if (!structuredKind) continue;
				if (!this.structured.has(file.path)) {
					const guid = newGuid();
					this.indexDoc.transact(() => {
						this.structured.set(file.path, { guid, kind: structuredKind });
					});
					this.ensureStructuredDocument(file.path, guid, structuredKind, true);
				} else {
					const meta = this.structured.get(file.path)!;
					this.ensureStructuredDocument(file.path, meta.guid, meta.kind, false);
				}
				continue;
			}
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

		new Notice(`Realtime: connected, syncing ${this.documents.size + this.structuredDocuments.size} files.`);

		// Reconcile binary files against the blob store (after the text pass so
		// note sync wins the bandwidth while binaries settle in the background).
		void this.binarySync.reconcileAll(this.localBinaryPaths());
		if (this.plugin.settings.syncConfigEnabled) {
			this.configSync.start(this.plugin.settings.configIncludeGlobs);
		}
	}

	/** Vault-relative paths of all local files classified as binary. */
	private localBinaryPaths(): string[] {
		return this.plugin.app.vault
			.getFiles()
			.filter((f) => this.classify(f) === "binary")
			.map((f) => f.path);
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

	private onStructuredChanged(event: Y.YMapEvent<StructuredMeta>): void {
		if (this.destroyed) return;
		event.changes.keys.forEach((change, path) => {
			if (change.action === "add" || change.action === "update") {
				const meta = this.structured.get(path);
				if (meta) this.ensureStructuredDocument(path, meta.guid, meta.kind, false);
			} else if (change.action === "delete") {
				this.handleRemoteDelete(path);
			}
		});
	}

	private async handleRemoteDelete(path: string): Promise<void> {
		if (this.destroyed) return;
		// A remote delete is authoritative: drop our Document and remove the local
		// file. We deliberately do not gate on local edits or whether the file is
		// open — the index is the source of truth, so the delete propagates.
		this.removeDocument(path);
		this.removeStructuredDocument(path);
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			try {
				await this.plugin.app.vault.delete(file);
			} catch (e) {
				console.error(`[Realtime] failed to apply remote delete for ${path}`, e);
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

	private ensureStructuredDocument(path: string, guid: string, kind: StructuredKind, isCreator: boolean): StructuredDocument {
		const existing = this.structuredDocuments.get(path);
		if (existing && existing.guid === guid) return existing;
		if (existing) this.removeStructuredDocument(path);

		const serverDocId = `${this.plugin.settings.activeVaultId}__${guid}`;
		const doc = kind === "canvas"
			? new CanvasDocument(this.plugin, path, guid, serverDocId, isCreator)
			: new BaseDocument(this.plugin, path, guid, serverDocId, isCreator);
		this.structuredDocuments.set(path, doc);
		this.plugin.applyAwarenessTo(doc);
		return doc;
	}

	private removeStructuredDocument(path: string): void {
		const doc = this.structuredDocuments.get(path);
		if (doc) {
			doc.destroy();
			this.structuredDocuments.delete(path);
		}
	}

	/** Record that a text document just synced (called by {@link Document}). */
	noteTextActivity(): void {
		this.lastTextActivityAt = Date.now();
	}

	/**
	 * True while notes are actively syncing — the index isn't connected/synced yet,
	 * or a text document synced within the last {@link quietMs}. The binary upload
	 * queue uses this to hold large transfers back until things are quiet.
	 */
	isTextSyncBusy(quietMs = 2000): boolean {
		if (!this.initialSynced) return true;
		return Date.now() - this.lastTextActivityAt < quietMs;
	}

	getDocumentForPath(path: string): Document | undefined {
		return this.documents.get(path);
	}

	allDocuments(): Array<Document | StructuredDocument> {
		return [...this.documents.values(), ...this.structuredDocuments.values()];
	}

	bindOpenCanvases(): void {
		for (const doc of this.structuredDocuments.values()) {
			if (doc instanceof CanvasDocument) doc.tryBindLiveCanvas();
		}
	}

	// --- Local vault events ----------------------------------------------------

	private registerVaultEvents(): void {
		const vault = this.plugin.app.vault;

		this.vaultEvents = [
			vault.on("create", (file) => this.onLocalCreate(file)),
			vault.on("delete", (file) => this.onLocalDelete(file)),
			vault.on("rename", (file, oldPath) => this.onLocalRename(file, oldPath)),
			vault.on("modify", (file) => this.onLocalModify(file)),
		];
	}

	/**
	 * Decide how a file syncs: `text` (Markdown, via a {@link Document} CRDT),
	 * `binary` (everything else, via {@link BinarySync}'s blob store), or `ignore`
	 * (folders, conflict copies, and — when binary sync is off or excluded — the
	 * non-Markdown files).
	 */
	private classify(file: TAbstractFile): FileKind {
		if (!(file instanceof TFile)) return "ignore";
		if (isConflictCopy(file.path)) return "ignore";
		if (file.extension === "md") return "text";
		if (file.extension === "canvas" && this.plugin.settings.syncCanvases) return "structured";
		if (file.extension === "base" && this.plugin.settings.syncBases) return "structured";
		if (!this.plugin.settings.syncBinaries) return "ignore";
		if (matchesAnyGlob(file.path, parseGlobs(this.plugin.settings.binaryExcludeGlobs))) {
			return "ignore";
		}
		return "binary";
	}

	private structuredKindForExtension(extension: string): StructuredKind | null {
		if (extension === "canvas") return "canvas";
		if (extension === "base") return "base";
		return null;
	}

	private onLocalCreate(file: TAbstractFile): void {
		if (this.destroyed || !this.initialSynced) return;
		const kind = this.classify(file);
		if (kind === "binary") {
			this.binarySync.onLocalChanged(file.path);
			return;
		}
		if (kind === "structured" && file instanceof TFile) {
			const structuredKind = this.structuredKindForExtension(file.extension);
			if (!structuredKind) return;
			if (this.structured.has(file.path)) {
				const meta = this.structured.get(file.path)!;
				this.ensureStructuredDocument(file.path, meta.guid, meta.kind, false);
				return;
			}
			const guid = newGuid();
			this.indexDoc.transact(() => {
				this.structured.set(file.path, { guid, kind: structuredKind });
			});
			this.ensureStructuredDocument(file.path, guid, structuredKind, true);
			return;
		}
		if (kind !== "text") return;
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
		if (this.destroyed || !this.initialSynced) return;
		const path = file.path;
		if (this.documents.has(path) || this.files.has(path)) {
			this.removeDocument(path);
			if (this.files.has(path)) {
				this.indexDoc.transact(() => {
					this.files.delete(path);
				});
			}
			return;
		}
		if (this.structuredDocuments.has(path) || this.structured.has(path)) {
			this.removeStructuredDocument(path);
			if (this.structured.has(path)) {
				this.indexDoc.transact(() => {
					this.structured.delete(path);
				});
			}
			return;
		}
		// Binary (or formerly-binary) file: let BinarySync propagate the delete.
		this.binarySync.onLocalDeleted(path);
	}

	private onLocalRename(file: TAbstractFile, oldPath: string): void {
		if (this.destroyed || !this.initialSynced || !(file instanceof TFile)) return;
		const newPath = file.path;

		// Drop tracking of the old path on the text side.
		const wasTracked = this.files.has(oldPath);
		const guid = this.files.get(oldPath) ?? this.documents.get(oldPath)?.guid;
		const wasStructuredTracked = this.structured.has(oldPath);
		const oldStructured = this.structured.get(oldPath) ?? this.structuredDocuments.get(oldPath);
		this.removeDocument(oldPath);
		this.removeStructuredDocument(oldPath);
		if (wasTracked) {
			this.indexDoc.transact(() => this.files.delete(oldPath));
		}
		if (wasStructuredTracked) {
			this.indexDoc.transact(() => this.structured.delete(oldPath));
		}

		const kind = this.classify(file);
		if (kind === "text") {
			const finalGuid = guid ?? newGuid();
			this.indexDoc.transact(() => {
				this.files.set(newPath, finalGuid);
			});
			this.registerFile(newPath, finalGuid);
			this.ensureDocument(newPath, finalGuid, !wasTracked);
		} else if (kind === "structured") {
			const structuredKind = this.structuredKindForExtension(file.extension);
			if (!structuredKind) return;
			const finalGuid = oldStructured?.guid ?? newGuid();
			this.indexDoc.transact(() => {
				this.structured.set(newPath, { guid: finalGuid, kind: structuredKind });
			});
			this.ensureStructuredDocument(newPath, finalGuid, structuredKind, !wasStructuredTracked);
		} else if (kind === "binary") {
			// Reconcile both old (now gone) and new paths on the binary side.
			this.binarySync.onLocalRenamed(file, oldPath);
		} else {
			// Renamed to an ignored path: ensure any old binary entry is dropped.
			this.binarySync.onLocalDeleted(oldPath);
		}
	}

	private onLocalModify(file: TAbstractFile): void {
		if (this.destroyed || !this.initialSynced) return;
		const kind = this.classify(file);
		if (kind === "binary") {
			this.binarySync.onLocalChanged(file.path);
			return;
		}
		if (kind === "structured") {
			const doc = this.structuredDocuments.get(file.path);
			if (doc) void doc.onDiskChanged();
			return;
		}
		if (kind !== "text") return;
		const doc = this.documents.get(file.path);
		if (doc) void doc.onDiskChanged();
	}

	// --- Lifecycle -------------------------------------------------------------

		destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		const vault = this.plugin.app.vault;
		for (const ref of this.vaultEvents) vault.offref(ref);
		this.vaultEvents = [];
		this.binarySync.destroy();
		this.configSync.destroy();
		this.files.unobserve(this.filesObserver);
		this.structured.unobserve(this.structuredObserver);
		this.indexProvider.off(EVENT_CONNECTION_STATUS, this.statusListener);
		for (const doc of this.documents.values()) doc.destroy();
		this.documents.clear();
		for (const doc of this.structuredDocuments.values()) doc.destroy();
		this.structuredDocuments.clear();
		this.indexProvider.destroy();
		void this.indexPersistence.destroy();
		this.indexDoc.destroy();
	}
}
