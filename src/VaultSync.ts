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
import { TFile, TAbstractFile, Notice, Platform, type EventRef } from "obsidian";
import type RealtimePlugin from "./main";
import { getClientToken } from "./ysweet";
import { connectYSweetProvider } from "./ysweetConnect";
import { muxProviderOptions } from "./sync/wsPolyfill";
import { Document } from "./Document";
import { CanvasDocument } from "./CanvasDocument";
import { BaseDocument } from "./BaseDocument";
import type { StructuredDocument } from "./StructuredDocument";
import { BinarySync } from "./BinarySync";
import { ConfigSync } from "./ConfigSync";
import { matchesAnyGlob, parseGlobs } from "./glob";

type FileKind = "text" | "structured" | "binary" | "ignore";
type StructuredKind = "canvas" | "base";
type QueueKind = "text" | StructuredKind;
interface QueueItem {
  path: string;
  guid: string;
  kind: QueueKind;
}
interface StructuredMeta {
  guid: string;
  kind: StructuredKind;
}

/**
 * Document kind recorded for a trashed (deleted but recoverable) file.
 * `plugindb` is a third-party plugin's synced-SQLite database (see src/pluginDb).
 */
export type TrashKind = "text" | "canvas" | "base" | "binary" | "plugindb";

/** Stored value of a `trash` map entry (the map key is the entry id). */
export interface TrashEntryValue {
  /**
   * Vault-relative path the file had when it was deleted. For `plugindb`
   * entries this is a human-readable label (`${pluginId}/${name}`) so the
   * existing path filter/column keeps working.
   */
  path: string;
  kind: TrashKind;
  /** Document guid for text/structured kinds; lets restore re-pull content. */
  guid?: string;
  /** Blob hash + byte size for binary kinds; lets restore re-download bytes. */
  hash?: string;
  size?: number;
  /** Owning plugin id (only for `plugindb` kind). */
  pluginId?: string;
  /** Database name (only for `plugindb` kind). */
  name?: string;
  /** Deletion time (ms epoch), for newest-first ordering. */
  deletedAt: number;
}

/** A trash entry with its map-key id attached, as surfaced to the UI. */
export interface TrashEntry extends TrashEntryValue {
  id: string;
}

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
  /** Shared map of trash entry id -> deleted-file metadata (recoverable). */
  private trash: Y.Map<TrashEntryValue>;
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
  private docQueue = new Map<string, QueueItem>();
  private activeDocConnections = 0;
  private highPriorityDrained = false;
  private backgroundSyncStarted = false;
  private prioritizedPaths = new Set<string>();
  private prioritizedGuids = new Set<string>();

  constructor(plugin: RealtimePlugin) {
    this.plugin = plugin;

    this.indexDoc = new Y.Doc();
    this.files = this.indexDoc.getMap("files");
    this.structured = this.indexDoc.getMap("structured");
    this.trash = this.indexDoc.getMap("trash");
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
      { connect: false, showDebuggerLink: false, ...muxProviderOptions(plugin) },
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
    void connectYSweetProvider(this.indexProvider);
  }

  /** Nudge the index provider and every document to reconnect if stalled. */
  reconnectAll(): void {
    if (this.destroyed) return;
    const status = this.indexProvider.status;
    if (status === STATUS_OFFLINE || status === STATUS_ERROR) {
      void connectYSweetProvider(this.indexProvider);
    }
    for (const doc of this.documents.values()) doc.ensureConnected();
    for (const doc of this.structuredDocuments.values()) doc.ensureConnected();
    this.pumpDocQueue();
  }

  prioritizeItem(opts: { path?: string; guid?: string }): void {
    const path = opts.path?.trim() || (opts.guid ? this.pathForGuid(opts.guid) : null);
    if (opts.guid) this.prioritizedGuids.add(opts.guid);
    if (!path) return;
    this.enqueueKnownPath(path, true);
    this.pumpDocQueue();
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

  /**
   * Wait until a vault item (located by `path` and/or `guid`) is resolvable on
   * disk as a {@link TFile}, or until `timeoutMs` (default 15s) elapses.
   *
   * Re-resolves the path on every check so a guid that the index only merges
   * after the wait starts is still picked up. Both conditions must hold: the
   * shared index must map the guid → path (or a path was given), AND the file
   * must exist on disk (the index entry alone is insufficient — the Document
   * pipeline writes the file via {@link Document#writeToDisk} asynchronously).
   * This method never creates documents or triggers sync; it only re-checks.
   *
   * Responsive without polling latency: a ~250ms interval is the backstop, and
   * observers on `files`/`structured` re-check immediately on any
   * remote merge. Tolerates the IndexedDB-loading startup phase — it does not
   * depend on `reconnectAll`'s timing, just on the index merge + disk write
   * landing. Resolves `null` on timeout or if this sync is destroyed mid-wait.
   */
  async waitForItem(opts: {
    guid?: string;
    path?: string;
    timeoutMs?: number;
  }): Promise<TFile | null> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;

    return new Promise<TFile | null>((resolve) => {
      let settled = false;
      let attached = false;
      let timer: ReturnType<typeof setInterval> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const filesObserver = (): void => check();
      const structuredObserver = (): void => check();

      // Single, idempotent cleanup/exit path. Safe to call from every exit
      // (immediate success, observer hit, timer tick, timeout, destroy).
      const finish = (result: TFile | null): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearInterval(timer);
        if (timeoutTimer !== null) clearTimeout(timeoutTimer);
        // Only unobserve what we actually attached; unobserving a handler that
        // was never registered logs a yjs console.error.
        if (attached) {
          this.files.unobserve(filesObserver);
          this.structured.unobserve(structuredObserver);
        }
        resolve(result);
      };

      const check = (): void => {
        if (this.destroyed) {
          finish(null);
          return;
        }
        // Re-resolve every tick: a guid may map to a path only after the wait
        // starts (index merge lands mid-wait). An explicit path takes precedence.
        const path = opts.path?.trim() || (opts.guid ? this.pathForGuid(opts.guid) : null);
        if (!path) return; // not ready yet — keep waiting (don't stop at "guid unknown")
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) finish(file);
        // Otherwise keep waiting: the index entry alone is insufficient.
      };

      // Synchronous happy path before wiring up observers/timer (no cleanup to
      // do if this settles immediately).
      check();
      if (settled) return;

      // Re-check immediately on any remote index merge (responsive without
      // waiting for the next poll tick).
      this.files.observe(filesObserver);
      this.structured.observe(structuredObserver);
      attached = true;

      // Poll backstop covers the disk-write lag, destroy, and any miss the
      // observers don't see (e.g. the file landing on disk without an index
      // change because the index already had the entry).
      timer = setInterval(() => {
        check();
      }, 250);
      timeoutTimer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
    });
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

    const priorityPaths = this.startupPriorityPaths();

    // Register entries that already exist in the shared index, but connect lazily.
    for (const [path, guid] of this.files.entries()) {
      this.registerFile(path, guid);
      this.enqueueDoc({ path, guid, kind: "text" }, priorityPaths.has(path));
    }
    for (const [path, meta] of this.structured.entries()) {
      this.registerFile(path, meta.guid);
      this.enqueueDoc({ path, guid: meta.guid, kind: meta.kind }, priorityPaths.has(path));
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
          const doc = this.ensureStructuredDocument(file.path, guid, structuredKind, true);
          await doc.whenReady();
          if (this.destroyed) return;
          this.indexDoc.transact(() => {
            this.structured.set(file.path, { guid, kind: structuredKind });
          });
          this.registerFile(file.path, guid);
        } else {
          const meta = this.structured.get(file.path)!;
          this.registerFile(file.path, meta.guid);
          this.enqueueDoc(
            { path: file.path, guid: meta.guid, kind: meta.kind },
            priorityPaths.has(file.path),
          );
        }
        continue;
      }
      if (!this.files.has(file.path)) {
        const guid = newGuid();
        const doc = this.ensureDocument(file.path, guid, true);
        await doc.whenReady();
        if (this.destroyed) return;
        this.indexDoc.transact(() => {
          this.files.set(file.path, guid);
        });
        this.registerFile(file.path, guid);
      } else {
        this.registerFile(file.path, this.files.get(file.path)!);
        this.enqueueDoc(
          { path: file.path, guid: this.files.get(file.path)!, kind: "text" },
          priorityPaths.has(file.path),
        );
      }
    }

    this.pumpDocQueue();
    if (this.prioritizedPaths.size === 0) {
      this.highPriorityDrained = true;
      this.startBackgroundSyncAfterPriorityDrain();
    }

    new Notice(
      `Realtime: connected, syncing ${this.documents.size + this.structuredDocuments.size} files.`,
    );

    // Reconcile binary files against the blob store (after the text pass so
    // note sync wins the bandwidth while binaries settle in the background).
    this.startBackgroundSyncAfterPriorityDrain();
  }

  private startupPriorityPaths(): Set<string> {
    const paths = new Set<string>();
    const add = (file: TFile | null | undefined) => {
      if (file && (file.extension === "md" || this.structuredKindForExtension(file.extension))) {
        paths.add(file.path);
      }
    };
    add((this.plugin.app.workspace as any).getActiveFile?.());
    (this.plugin.app.workspace as any).iterateAllLeaves?.((leaf: any) => add(leaf?.view?.file));
    const recentPaths = Array.isArray(this.plugin.settings.recentPaths)
      ? this.plugin.settings.recentPaths
      : [];
    for (const path of recentPaths) paths.add(path);
    return paths;
  }

  private enqueueKnownPath(path: string, front = false): void {
    const guid = this.files.get(path);
    if (guid) this.enqueueDoc({ path, guid, kind: "text" }, front);
    const meta = this.structured.get(path);
    if (meta) this.enqueueDoc({ path, guid: meta.guid, kind: meta.kind }, front);
  }

  private enqueueDoc(item: QueueItem, front = false): void {
    if (this.destroyed) return;
    if (item.kind === "text" && this.documents.has(item.path)) return;
    if (item.kind !== "text" && this.structuredDocuments.has(item.path)) return;
    if (front) this.prioritizedPaths.add(item.path);
    if (front) {
      this.docQueue.delete(item.path);
      this.docQueue = new Map([[item.path, item], ...this.docQueue]);
    } else if (!this.docQueue.has(item.path)) {
      this.docQueue.set(item.path, item);
    }
  }

  private pumpDocQueue(): void {
    if (this.destroyed) return;
    const concurrency = Platform?.isMobile ? 1 : 2;
    while (this.activeDocConnections < concurrency && this.docQueue.size > 0) {
      const [path, item] = this.docQueue.entries().next().value as [string, QueueItem];
      this.docQueue.delete(path);
      const doc =
        item.kind === "text"
          ? this.ensureDocument(item.path, item.guid, false, false)
          : this.ensureStructuredDocument(item.path, item.guid, item.kind, false, false);
      this.activeDocConnections++;
      doc.connect();
      void doc.whenReady().finally(() => {
        this.activeDocConnections = Math.max(0, this.activeDocConnections - 1);
        this.prioritizedPaths.delete(item.path);
        this.prioritizedGuids.delete(item.guid);
        if (!this.highPriorityDrained && this.prioritizedPaths.size === 0) {
          this.highPriorityDrained = true;
          this.startBackgroundSyncAfterPriorityDrain();
        }
        this.pumpDocQueue();
      });
    }
  }

  private startBackgroundSyncAfterPriorityDrain(): void {
    if (!this.initialSynced || this.destroyed || !this.highPriorityDrained) return;
    if (this.backgroundSyncStarted) return;
    this.backgroundSyncStarted = true;
    void this.reconcileBinariesAndMigrateStructured();
    if (this.plugin.settings.syncConfigEnabled) {
      this.configSync.start(this.plugin.settings.configIncludeGlobs);
    }
  }

  private async reconcileBinariesAndMigrateStructured(): Promise<void> {
    await this.binarySync.reconcileAll(this.localBinaryPaths());
    if (this.destroyed) return;

    for (const path of this.binarySync.remotePaths()) {
      const structuredKind = this.structuredKindForPath(path);
      if (!structuredKind || this.structured.has(path)) continue;

      // Legacy sync stored canvases/bases as binary blobs. Pull the blob first,
      // then promote the path into the structured CRDT index for live sync.
      await this.binarySync.reconcilePath(path);
      if (this.destroyed) return;

      const localFile = this.plugin.app.vault.getAbstractFileByPath(path);
      if (!(localFile instanceof TFile)) continue;

      const guid = newGuid();
      this.indexDoc.transact(() => {
        this.structured.set(path, { guid, kind: structuredKind });
      });
      this.registerFile(path, guid);
      this.ensureStructuredDocument(path, guid, structuredKind, true);
      this.binarySync.stopTrackingPath(path);
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
        if (guid) {
          this.registerFile(path, guid);
          this.enqueueDoc(
            { path, guid, kind: "text" },
            this.prioritizedPaths.has(path) || this.prioritizedGuids.has(guid),
          );
          this.pumpDocQueue();
        }
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
        if (meta) {
          this.registerFile(path, meta.guid);
          this.enqueueDoc(
            { path, guid: meta.guid, kind: meta.kind },
            this.prioritizedPaths.has(path) || this.prioritizedGuids.has(meta.guid),
          );
          this.pumpDocQueue();
        }
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

  private ensureDocument(
    path: string,
    guid: string,
    isCreator: boolean,
    autoConnect = true,
  ): Document {
    const existing = this.documents.get(path);
    if (existing && existing.guid === guid) return existing;
    if (existing) this.removeDocument(path);

    const serverDocId = `${this.plugin.settings.activeVaultId}__${guid}`;
    const doc = new Document(this.plugin, path, guid, serverDocId, isCreator, { autoConnect });
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

  private ensureStructuredDocument(
    path: string,
    guid: string,
    kind: StructuredKind,
    isCreator: boolean,
    autoConnect = true,
  ): StructuredDocument {
    const existing = this.structuredDocuments.get(path);
    if (existing && existing.guid === guid) return existing;
    if (existing) this.removeStructuredDocument(path);

    const serverDocId = `${this.plugin.settings.activeVaultId}__${guid}`;
    const doc =
      kind === "canvas"
        ? new CanvasDocument(this.plugin, path, guid, serverDocId, isCreator, { autoConnect })
        : new BaseDocument(this.plugin, path, guid, serverDocId, isCreator, { autoConnect });
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

  ensureDocumentForPath(path: string): Document | undefined {
    const guid = this.files.get(path);
    if (!guid) return this.documents.get(path);
    const doc = this.ensureDocument(path, guid, false, false);
    this.prioritizedPaths.add(path);
    this.prioritizedGuids.add(guid);
    doc.connect();
    return doc;
  }

  allDocuments(): Array<Document | StructuredDocument> {
    return [...this.documents.values(), ...this.structuredDocuments.values()];
  }

  bindOpenCanvases(): void {
    for (const doc of this.structuredDocuments.values()) {
      if (doc instanceof CanvasDocument) doc.tryBindLiveCanvas();
    }
  }

  bindOpenBases(): void {
    for (const doc of this.structuredDocuments.values()) {
      if (doc instanceof BaseDocument) doc.tryBindLiveBase();
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

  private structuredKindForPath(path: string): StructuredKind | null {
    const dot = path.lastIndexOf(".");
    if (dot < 0 || dot < path.lastIndexOf("/")) return null;
    const extension = path.slice(dot + 1);
    const kind = this.structuredKindForExtension(extension);
    if (kind === "canvas" && !this.plugin.settings.syncCanvases) return null;
    if (kind === "base" && !this.plugin.settings.syncBases) return null;
    return kind;
  }

  private onLocalCreate(file: TAbstractFile): void {
    void this.handleLocalCreate(file);
  }

  private async handleLocalCreate(file: TAbstractFile): Promise<void> {
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
        this.registerFile(file.path, meta.guid);
        this.ensureStructuredDocument(file.path, meta.guid, meta.kind, false);
        return;
      }
      const guid = newGuid();
      const doc = this.ensureStructuredDocument(file.path, guid, structuredKind, true);
      await doc.whenReady();
      if (this.destroyed) return;
      this.indexDoc.transact(() => {
        this.structured.set(file.path, { guid, kind: structuredKind });
      });
      this.registerFile(file.path, guid);
      return;
    }
    if (kind !== "text") return;
    if (this.files.has(file.path)) {
      // Created locally because a remote entry arrived; Document handles it.
      this.registerFile(file.path, this.files.get(file.path)!);
      this.ensureDocument(file.path, this.files.get(file.path)!, false);
      return;
    }
    const guid = newGuid();
    const doc = this.ensureDocument(file.path, guid, true);
    await doc.whenReady();
    if (this.destroyed) return;
    // Publish the index entry only after the creator's file doc has seeded and
    // synced, so peers do not materialize an empty remote-created note.
    this.indexDoc.transact(() => {
      this.files.set(file.path, guid);
    });
    this.registerFile(file.path, guid);
  }

  private onLocalDelete(file: TAbstractFile): void {
    if (this.destroyed || !this.initialSynced) return;
    const path = file.path;
    if (this.documents.has(path) || this.files.has(path)) {
      this.removeDocument(path);
      if (this.files.has(path)) {
        const guid = this.files.get(path)!;
        this.indexDoc.transact(() => {
          this.recordTrashIn({ path, kind: "text", guid });
          this.files.delete(path);
        });
      }
      return;
    }
    if (this.structuredDocuments.has(path) || this.structured.has(path)) {
      this.removeStructuredDocument(path);
      if (this.structured.has(path)) {
        const meta = this.structured.get(path)!;
        this.indexDoc.transact(() => {
          this.recordTrashIn({ path, kind: meta.kind, guid: meta.guid });
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
      this.registerFile(newPath, finalGuid);
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

  // --- Trash -----------------------------------------------------------------

  /** Write a trash entry inside an already-open index transaction. */
  private recordTrashIn(entry: {
    path: string;
    kind: TrashKind;
    guid?: string;
    hash?: string;
    size?: number;
    pluginId?: string;
    name?: string;
  }): void {
    const value: TrashEntryValue = { path: entry.path, kind: entry.kind, deletedAt: Date.now() };
    if (entry.guid !== undefined) value.guid = entry.guid;
    if (entry.hash !== undefined) value.hash = entry.hash;
    if (entry.size !== undefined) value.size = entry.size;
    if (entry.pluginId !== undefined) value.pluginId = entry.pluginId;
    if (entry.name !== undefined) value.name = entry.name;
    this.trash.set(newGuid(), value);
  }

  /** Record a deleted file in the shared trash (its own transaction). */
  recordTrash(entry: {
    path: string;
    kind: TrashKind;
    guid?: string;
    hash?: string;
    size?: number;
    pluginId?: string;
    name?: string;
  }): void {
    if (this.destroyed) return;
    this.indexDoc.transact(() => this.recordTrashIn(entry));
  }

  /** Current trash entries, newest deletion first. */
  listTrash(): TrashEntry[] {
    const out: TrashEntry[] = [];
    for (const [id, value] of this.trash.entries()) {
      if (value) out.push({ id, ...value });
    }
    out.sort((a, b) => b.deletedAt - a.deletedAt);
    return out;
  }

  /** Subscribe to trash changes; returns an unsubscribe function. */
  observeTrash(cb: () => void): () => void {
    const observer = () => cb();
    this.trash.observe(observer);
    return () => this.trash.unobserve(observer);
  }

  /** True when a path is occupied by a tracked doc, blob, or local file. */
  private pathInUse(path: string): boolean {
    if (this.files.has(path) || this.structured.has(path)) return true;
    if (this.binarySync.hasPath(path)) return true;
    return !!this.plugin.app.vault.getAbstractFileByPath(path);
  }

  /**
   * Restore a trashed file. Re-adds the index entry (content re-materializes
   * from the retained y-sweet doc / blob) at the original path, or `targetPath`
   * when supplied. Throws if the destination is already occupied.
   */
  async restoreTrashEntry(id: string, targetPath?: string): Promise<void> {
    if (this.destroyed) return;
    const value = this.trash.get(id);
    if (!value) throw new Error("This trash entry no longer exists.");

    // Plugin databases have no destination path to retarget: restore re-opens
    // the per-DB doc by clearing its `meta.deletedAt` tombstone. We must not
    // touch `files`/`structured` or run the `pathInUse` guard for these.
    if (value.kind === "plugindb") {
      const pluginId = value.pluginId;
      const name = value.name;
      if (!pluginId || !name) throw new Error("Trash entry is missing its database identity.");
      const sqlApi = this.plugin.sqlApi;
      if (!sqlApi) throw new Error("The SQL API is not available.");
      if (await sqlApi.isLive({ pluginId, name })) {
        throw new Error(`A database "${pluginId}/${name}" is already active — delete it first.`);
      }
      await sqlApi.restore({ pluginId, name });
      this.indexDoc.transact(() => this.trash.delete(id));
      return;
    }

    const path = (targetPath ?? "").trim() || value.path;
    if (this.pathInUse(path))
      throw new Error(`"${path}" already exists — restore under a different name.`);

    if (value.kind === "binary") {
      if (!value.hash) throw new Error("Trash entry is missing its attachment data.");
      this.binarySync.restoreEntry(path, value.hash, value.size ?? 0);
    } else if (value.kind === "text") {
      if (!value.guid) throw new Error("Trash entry is missing its document id.");
      const guid = value.guid;
      this.indexDoc.transact(() => this.files.set(path, guid));
      this.registerFile(path, guid);
      this.ensureDocument(path, guid, false);
    } else {
      if (!value.guid) throw new Error("Trash entry is missing its document id.");
      const guid = value.guid;
      const kind = value.kind;
      this.indexDoc.transact(() => this.structured.set(path, { guid, kind }));
      this.registerFile(path, guid);
      this.ensureStructuredDocument(path, guid, kind, false);
    }

    this.indexDoc.transact(() => this.trash.delete(id));
  }

  /**
   * Permanently drop a trash entry. For binaries this also reclaims the orphaned
   * blob (skipped server-side if still referenced). Text/structured docs are
   * orphaned: their y-sweet content lingers but is no longer reachable.
   */
  async permanentlyDeleteTrashEntry(id: string): Promise<void> {
    if (this.destroyed) return;
    const value = this.trash.get(id);
    if (!value) return;
    if (value.kind === "binary" && value.hash && !this.binarySync.hasHash(value.hash)) {
      try {
        await this.plugin.auth.deleteBlob(this.plugin.settings.activeVaultId, value.hash);
      } catch (e) {
        console.error(`[Realtime] failed to delete blob for trashed ${value.path}`, e);
      }
    } else if (value.kind === "plugindb" && value.pluginId && value.name) {
      // Purge the server replica + git dump and trim the per-DB doc. Mirror
      // the binary branch: log a server failure but still drop the entry.
      try {
        await this.plugin.auth.deletePluginDb(
          this.plugin.settings.activeVaultId,
          value.pluginId,
          value.name,
        );
      } catch (e) {
        console.error(`[Realtime] failed to purge plugin db for trashed ${value.path}`, e);
      }
    }
    this.indexDoc.transact(() => this.trash.delete(id));
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
