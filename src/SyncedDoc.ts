import * as Y from "yjs";
import { YSweetProvider, STATUS_ERROR, STATUS_OFFLINE } from "@y-sweet/client";
import type { Awareness } from "y-protocols/awareness";
import { IndexeddbPersistence } from "y-indexeddb";
import type RealtimePlugin from "./main";
import { getClientToken } from "./ysweet";
import { connectYSweetProvider } from "./ysweetConnect";
import { muxProviderOptions } from "./sync/wsPolyfill";

export abstract class SyncedDoc {
  readonly path: string;
  readonly guid: string;
  readonly serverDocId: string;
  readonly ydoc: Y.Doc;
  readonly provider: YSweetProvider;
  readonly awareness: Awareness;
  isCreator: boolean;

  protected readonly plugin: RealtimePlugin;
  protected destroyed = false;
  protected readonly persistence: IndexeddbPersistence;

  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private syncedListener: (synced: boolean) => void;
  private autoConnect: boolean;

  protected constructor(
    plugin: RealtimePlugin,
    path: string,
    guid: string,
    serverDocId: string,
    isCreator: boolean,
    opts: { autoConnect?: boolean } = {},
  ) {
    this.plugin = plugin;
    this.path = path;
    this.guid = guid;
    this.serverDocId = serverDocId;
    this.isCreator = isCreator;
    this.autoConnect = opts.autoConnect ?? true;
    this.ydoc = new Y.Doc();

    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    this.provider = new YSweetProvider(
      () => getClientToken(plugin, serverDocId),
      serverDocId,
      this.ydoc,
      { connect: false, showDebuggerLink: false, ...muxProviderOptions() },
    );
    this.awareness = this.provider.awareness;
    this.persistence = new IndexeddbPersistence(serverDocId, this.ydoc);

    this.syncedListener = (synced) => {
      if (synced) void this.finishStartupReconcile();
    };
    this.provider.on("synced", this.syncedListener);

    void this.init();
  }

  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  ensureConnected(): void {
    if (this.destroyed) return;
    const status = this.provider.status;
    if (status === STATUS_OFFLINE || status === STATUS_ERROR) {
      void connectYSweetProvider(this.provider);
    }
  }

  connect(): void {
    this.ensureConnected();
  }

  protected resolveWhenReady(): void {
    this.resolveReady();
  }

  protected async init(): Promise<void> {
    try {
      await this.persistence.whenSynced;
      if (!this.destroyed) await this.afterPersistenceSynced();
    } catch (e) {
      console.error(`[Realtime] init failed for ${this.path}`, e);
      this.resolveWhenReady();
    }

    if (!this.destroyed && this.autoConnect) void connectYSweetProvider(this.provider);
  }

  protected abstract afterPersistenceSynced(): Promise<void> | void;
  protected abstract finishStartupReconcile(): Promise<void>;
  protected abstract destroySubclass(): void;

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroySubclass();
    this.provider.off("synced", this.syncedListener);
    this.provider.destroy();
    void this.persistence.destroy();
    this.ydoc.destroy();
  }
}
