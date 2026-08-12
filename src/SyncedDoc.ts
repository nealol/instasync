import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { IndexeddbPersistence, storeState } from "y-indexeddb";
import type RealtimePlugin from "./main";
import { getClientToken } from "./sync/clientToken";
import {
  RealtimeProvider,
  SYNC_EVENT_LOCAL_CHANGES,
  SYNC_STATUS_ERROR,
  SYNC_STATUS_OFFLINE,
} from "./sync/RealtimeProvider";
import { createMuxSocket } from "./sync/mux";
import { epochPersistenceName } from "./documentEpoch";

export abstract class SyncedDoc {
  readonly path: string;
  readonly guid: string;
  readonly serverDocId: string;
  readonly ydoc: Y.Doc;
  readonly provider: RealtimeProvider;
  readonly awareness: Awareness;
  isCreator: boolean;

  protected readonly plugin: RealtimePlugin;
  protected destroyed = false;
  protected readonly persistence: IndexeddbPersistence;

  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private ready = false;
  private syncedListener: (synced: boolean) => void;
  private localChangesListener: (hasLocalChanges: boolean) => void;
  private readonly autoConnect: boolean;
  private persistenceReady = false;
  private connectRequested = false;
  /** True once the provider has reported a successful server sync at least once. */
  private syncedOnce = false;
  private nextServerSyncWaiters = new Set<() => void>();

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

    this.provider = new RealtimeProvider(
      serverDocId,
      this.ydoc,
      () => getClientToken(plugin, serverDocId, path),
      { connect: false, socketFactory: createMuxSocket },
    );
    this.awareness = this.provider.awareness;
    this.persistence = new IndexeddbPersistence(
      epochPersistenceName(plugin, serverDocId, serverDocId),
      this.ydoc,
    );

    this.syncedListener = (synced) => {
      if (synced) {
        this.syncedOnce = true;
        this.resolveNextServerSyncWaiters();
        void this.finishStartupReconcile();
      }
    };
    this.provider.on("synced", this.syncedListener);
    this.localChangesListener = (hasLocalChanges) => {
      if (!hasLocalChanges && !this.destroyed) void this.afterChangesSynced();
    };
    this.provider.on(SYNC_EVENT_LOCAL_CHANGES, this.localChangesListener);

    void this.init();
  }

  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** True once the first successful server sync has been observed. */
  get hasSyncedOnce(): boolean {
    return this.syncedOnce;
  }

  /**
   * True while the provider is online (or trying to be) — i.e. a server sync is
   * expected that could deliver content we don't yet have locally. When offline
   * or errored, no sync can arrive, so local content must be persisted as-is.
   */
  get isProviderOnline(): boolean {
    const status = this.provider.status;
    return status !== SYNC_STATUS_OFFLINE && status !== SYNC_STATUS_ERROR;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  ensureConnected(): void {
    if (this.destroyed) return;
    this.connectRequested = true;
    if (!this.persistenceReady) return;
    this.connectProvider();
  }

  private connectProvider(): void {
    const status = this.provider.status;
    if (status === SYNC_STATUS_OFFLINE || status === SYNC_STATUS_ERROR) {
      void this.provider.connect();
    }
  }

  connect(): void {
    this.ensureConnected();
  }

  disconnect(): void {
    if (this.destroyed) return;
    this.provider.disconnect();
  }

  /**
   * Flush pending IndexedDB writes before releasing this document's in-memory
   * state. A document with unacknowledged server changes is never eligible.
   */
  async prepareForHibernation(): Promise<boolean> {
    if (
      this.destroyed ||
      !this.ready ||
      this.provider.hasLocalChanges ||
      !this.canHibernateLocally()
    ) {
      return false;
    }
    await storeState(this.persistence, false);
    return (
      !this.destroyed && this.ready && !this.provider.hasLocalChanges && this.canHibernateLocally()
    );
  }

  protected canHibernateLocally(): boolean {
    return true;
  }

  /** Resolve after the next successful server handshake. */
  whenNextServerSync(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.nextServerSyncWaiters.add(resolve);
    return promise;
  }

  private resolveNextServerSyncWaiters(): void {
    for (const resolve of this.nextServerSyncWaiters) resolve();
    this.nextServerSyncWaiters.clear();
  }

  protected resolveWhenReady(): void {
    if (this.ready) return;
    this.ready = true;
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

    this.persistenceReady = true;
    if (!this.destroyed && (this.autoConnect || this.connectRequested)) {
      this.connectProvider();
    }
  }

  protected abstract afterPersistenceSynced(): Promise<void> | void;
  protected abstract finishStartupReconcile(): Promise<void>;
  protected afterChangesSynced(): Promise<void> | void {}
  protected abstract destroySubclass(): void;

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroySubclass();
    this.provider.off("synced", this.syncedListener);
    this.provider.off(SYNC_EVENT_LOCAL_CHANGES, this.localChangesListener);
    this.provider.destroy();
    void this.persistence.destroy();
    this.ydoc.destroy();
    this.resolveNextServerSyncWaiters();
    this.resolveWhenReady();
  }
}
