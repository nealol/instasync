// A bare "second device": a Y.Doc + y-sweet provider with NO local persistence.
// Keeping the peer non-persistent sidesteps the single process-global
// `fake-indexeddb` store, so only the unit under test owns IndexedDB.

import * as Y from "yjs";
import { YSweetProvider } from "@y-sweet/client";
import { getClientToken } from "../../src/ysweet";
import { waitFor } from "./util";

export class Peer {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly provider: YSweetProvider;

  /**
   * A second device, minting tokens through the auth server like the real
   * plugin. `plugin` is a fakePlugin (carries authServerUrl/session/vault);
   * `serverDocId` is the namespaced doc id (`${vaultId}__${guid}` or the index
   * `${vaultId}`).
   */
  constructor(plugin: unknown, serverDocId: string) {
    this.doc = new Y.Doc();
    this.text = this.doc.getText("contents");
    this.provider = new YSweetProvider(
      () => getClientToken(plugin as any, serverDocId) as any,
      serverDocId,
      this.doc,
      { connect: true, showDebuggerLink: false },
    );
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
    return waitFor(() => this.provider.status === "connected");
  }

  destroy(): void {
    this.provider.destroy();
    this.doc.destroy();
  }
}
