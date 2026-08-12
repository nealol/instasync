// A bare second device: a Y.Doc + native provider with no local persistence.
// Keeping the peer non-persistent sidesteps the single process-global
// `fake-indexeddb` store, so only the unit under test owns IndexedDB.

import * as Y from "yjs";
import {
  RealtimeProvider,
  SYNC_EVENT_STATUS,
  type SyncStatus,
} from "../../src/sync/RealtimeProvider";
import { getClientToken } from "../../src/sync/clientToken";
import { waitFor } from "./util";

export class Peer {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly provider: RealtimeProvider;
  private readonly statuses: SyncStatus[] = [];

  /**
   * A second device, minting tokens through the auth server like the real
   * plugin. `plugin` is a fakePlugin (carries authServerUrl/session/vault);
   * `serverDocId` is the namespaced doc id (`${vaultId}__${guid}` or the index
   * `${vaultId}`).
   */
  constructor(plugin: unknown, serverDocId: string) {
    this.doc = new Y.Doc();
    this.text = this.doc.getText("contents");
    this.provider = new RealtimeProvider(serverDocId, this.doc, () =>
      getClientToken(plugin as any, serverDocId),
    );
    this.provider.on(SYNC_EVENT_STATUS, (status) => this.statuses.push(status));
  }

  setText(value: string): void {
    this.doc.transact(() => {
      this.text.delete(0, this.text.length);
      this.text.insert(0, value);
    });
  }

  getText(): string {
    return this.text.toString();
  }

  whenSynced(): Promise<void> {
    return waitFor(() => this.provider.status === "connected").catch((error: unknown) => {
      throw new Error(
        `peer did not sync; provider states: ${[...this.statuses, this.provider.status].join(
          " → ",
        )}; last error: ${this.provider.lastConnectionError ?? "none"}`,
        { cause: error },
      );
    });
  }

  whenChangesSynced(): Promise<void> {
    return waitFor(() => !this.provider.hasLocalChanges, {
      label: "peer changes acknowledged",
    });
  }

  destroy(): void {
    this.provider.destroy();
    this.doc.destroy();
  }
}
