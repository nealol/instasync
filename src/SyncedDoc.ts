import * as Y from "yjs";
import { YSweetProvider, STATUS_ERROR, STATUS_OFFLINE } from "@y-sweet/client";
import type { Awareness } from "y-protocols/awareness";
import { IndexeddbPersistence } from "y-indexeddb";
import type InstaSyncPlugin from "./main";
import { getClientToken } from "./ysweet";

export abstract class SyncedDoc {
	readonly path: string;
	readonly guid: string;
	readonly serverDocId: string;
	readonly ydoc: Y.Doc;
	readonly provider: YSweetProvider;
	readonly awareness: Awareness;
	isCreator: boolean;

	protected readonly plugin: InstaSyncPlugin;
	protected destroyed = false;
	protected readonly persistence: IndexeddbPersistence;

	private readyPromise: Promise<void>;
	private resolveReady!: () => void;
	private syncedListener: (synced: boolean) => void;

	protected constructor(
		plugin: InstaSyncPlugin,
		path: string,
		guid: string,
		serverDocId: string,
		isCreator: boolean,
	) {
		this.plugin = plugin;
		this.path = path;
		this.guid = guid;
		this.serverDocId = serverDocId;
		this.isCreator = isCreator;
		this.ydoc = new Y.Doc();

		this.readyPromise = new Promise((resolve) => {
			this.resolveReady = resolve;
		});

		this.provider = new YSweetProvider(
			() => getClientToken(plugin, serverDocId),
			serverDocId,
			this.ydoc,
			{ connect: false, showDebuggerLink: false },
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
			void this.provider.connect();
		}
	}

	protected resolveWhenReady(): void {
		this.resolveReady();
	}

	protected async init(): Promise<void> {
		try {
			await this.persistence.whenSynced;
			if (!this.destroyed) await this.afterPersistenceSynced();
		} catch (e) {
			console.error(`[InstaSync] init failed for ${this.path}`, e);
			this.resolveWhenReady();
		}

		if (!this.destroyed) void this.provider.connect();
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
