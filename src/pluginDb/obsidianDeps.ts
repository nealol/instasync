/**
 * Wiring that binds the (Obsidian-agnostic) {@link SyncedPluginDatabase} engine
 * to the live plugin: WASM resolution, snapshot persistence via the vault
 * adapter, the per-DB y-sweet transport, and the server bootstrap/touch calls.
 */

import * as Y from "yjs";
import {
  YSweetProvider,
  STATUS_CONNECTED,
  EVENT_CONNECTION_STATUS,
  EVENT_LOCAL_CHANGES,
  type YSweetStatus,
} from "@y-sweet/client";
import { IndexeddbPersistence } from "y-indexeddb";
import type RealtimePlugin from "../main";
import { getClientToken } from "../ysweet";
import { CRSQLITE_WASM_DATA_URL } from "./wasmBinary";
import type { PluginDbDocHandle } from "./PluginDbSync";
import type { SyncedPluginDatabaseOptions } from "./SyncedPluginDatabase";
import type { ChangeRow, Cursor } from "./types";

/**
 * Build the non-user-supplied engine deps for a given database.
 *
 * `locateWasm` returns the esbuild-inlined cr-sqlite WASM data URL — a single
 * synchronous value, so there is no separate asset, download, or async race.
 */
export function buildEngineDeps(
  plugin: RealtimePlugin,
  pluginId: string,
  name: string,
): Pick<
  SyncedPluginDatabaseOptions,
  | "locateWasm"
  | "makeDoc"
  | "loadSnapshot"
  | "saveSnapshot"
  | "deleteSnapshot"
  | "bootstrap"
  | "touch"
> {
  const vaultId = plugin.settings.activeVaultId;
  const adapter = plugin.app.vault.adapter;
  const dir = plugin.manifest.dir ?? `.obsidian/plugins/${plugin.manifest.id}`;
  const dbDir = `${dir}/plugin-dbs/${pluginId}`;
  const snapPath = `${dbDir}/${name}.snap`;
  const tmpPath = `${snapPath}.tmp`;

  return {
    locateWasm: () => CRSQLITE_WASM_DATA_URL,
    makeDoc: (docId) => makeDocHandle(plugin, docId),
    loadSnapshot: async () => {
      try {
        if (await adapter.exists(snapPath)) return await adapter.read(snapPath);
        // Crash recovery: the tmp file is only ever a fully-written snapshot
        // (write tmp → remove target → rename), so trust it if the final
        // file went missing mid-replace.
        if (await adapter.exists(tmpPath)) {
          console.warn("[Realtime] recovering plugin-db snapshot from tmp file");
          return await adapter.read(tmpPath);
        }
      } catch (e) {
        console.warn("[Realtime] snapshot read failed", e);
      }
      return null;
    },
    saveSnapshot: async (text) => {
      if (!(await adapter.exists(dbDir))) await adapter.mkdir(dbDir);
      // Write the full snapshot to a tmp file first, then swap it into
      // place with rename. A crash at any point leaves either the old
      // snapshot or a complete tmp file (recovered by loadSnapshot).
      await adapter.write(tmpPath, text);
      try {
        if (await adapter.exists(snapPath)) await adapter.remove(snapPath);
        await adapter.rename(tmpPath, snapPath);
      } catch {
        // Some adapters/platforms refuse the rename; fall back to a plain
        // write and keep the tmp file as the recovery copy until it lands.
        await adapter.write(snapPath, text);
        try {
          await adapter.remove(tmpPath);
        } catch {
          /* ignore */
        }
      }
    },
    deleteSnapshot: async () => {
      try {
        if (await adapter.exists(snapPath)) await adapter.remove(snapPath);
        if (await adapter.exists(tmpPath)) await adapter.remove(tmpPath);
      } catch (e) {
        console.warn("[Realtime] snapshot delete failed", e);
      }
    },
    bootstrap: async (cursor: Cursor): Promise<ChangeRow[]> => {
      try {
        return await plugin.auth.pluginDbChanges(vaultId, pluginId, name, cursor);
      } catch (e) {
        console.warn("[Realtime] plugin db bootstrap failed", e);
        return [];
      }
    },
    touch: () => {
      void plugin.auth.touchPluginDb(vaultId, pluginId, name).catch(() => {});
    },
  };
}

/** A per-DB y-sweet + IndexedDB transport handle. */
function makeDocHandle(plugin: RealtimePlugin, docId: string): PluginDbDocHandle {
  const doc = new Y.Doc();
  const provider = new YSweetProvider(() => getClientToken(plugin, docId), docId, doc, {
    connect: false,
    showDebuggerLink: false,
  });
  const persistence = new IndexeddbPersistence(docId, doc);

  let connected = false;
  const statusCbs = new Set<(c: boolean) => void>();
  const statusListener = (status: YSweetStatus) => {
    const c = status === STATUS_CONNECTED;
    if (c !== connected) {
      connected = c;
      for (const cb of statusCbs) cb(c);
    }
  };
  provider.on(EVENT_CONNECTION_STATUS, statusListener);

  const whenSynced = persistence.whenSynced
    .catch(() => {})
    .then(() => {
      void provider.connect();
      return firstSyncedOrTimeout(provider, 3000);
    });

  return {
    doc,
    whenSynced,
    isConnected: () => connected,
    onStatus: (cb) => {
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },
    // Wait (bounded) until the provider has no unacknowledged local changes,
    // so a final write right before destroy() — e.g. the delete tombstone —
    // actually reaches the server instead of dying with the WebSocket.
    whenFlushed: () =>
      new Promise<void>((resolve) => {
        if (!provider.hasLocalChanges) return resolve();
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          provider.off(EVENT_LOCAL_CHANGES, onChange as never);
          resolve();
        };
        const onChange = (has: boolean) => {
          if (!has) finish();
        };
        provider.on(EVENT_LOCAL_CHANGES, onChange as never);
        setTimeout(finish, 3000);
      }),
    destroy: () => {
      provider.off(EVENT_CONNECTION_STATUS, statusListener);
      provider.destroy();
      void persistence.destroy();
      doc.destroy();
    },
  };
}

/** Resolve on the provider's first server sync, or after `ms` to stay offline-tolerant. */
function firstSyncedOrTimeout(provider: YSweetProvider, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      provider.off("synced", onSynced as never);
      resolve();
    };
    const onSynced = (synced: boolean) => {
      if (synced) finish();
    };
    provider.on("synced", onSynced as never);
    setTimeout(finish, ms);
  });
}
