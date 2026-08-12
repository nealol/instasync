import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { RealtimeProvider } from "../../src/sync/RealtimeProvider";
import { startAuthHarness, type AuthHarness } from "../support/authServer";
import { makeFakePlugin, type FakePlugin } from "../support/fakePlugin";
import { freshGuid, waitFor } from "../support/util";
import {
  resetDocumentEpochStateForTests,
  setDocumentEpoch,
  setEpochProposalHandler,
} from "../../src/documentEpoch";
import { getClientToken, resetTokenRetryStateForTests } from "../../src/sync/clientToken";
import { createMuxSocket, resetMuxForTests } from "../../src/sync/mux";

let harness: AuthHarness;
let token: string;
let vaultId: string;
let plugin: FakePlugin;

class EpochClient {
  doc!: Y.Doc;
  provider!: RealtimeProvider;

  constructor(readonly documentId: string) {
    this.connect();
  }

  get text(): Y.Text {
    return this.doc.getText("contents");
  }

  rebuild(): void {
    this.provider.destroy();
    this.doc.destroy();
    this.connect();
  }

  destroy(): void {
    this.provider.destroy();
    this.doc.destroy();
  }

  private connect(): void {
    this.doc = new Y.Doc();
    this.provider = new RealtimeProvider(
      this.documentId,
      this.doc,
      () => getClientToken(plugin as any, this.documentId),
      { socketFactory: createMuxSocket },
    );
  }
}

beforeAll(async () => {
  harness = await startAuthHarness({
    env: {
      // Two initial SyncStep2 responses plus these clients' two edits.
      // Keep enough headroom that reconnecting both fresh documents does not
      // immediately trigger a second rollover.
      CRDT_EPOCH_MAX_UPDATES: "4",
      CRDT_EPOCH_MAX_STATE_BYTES: "536870912",
      CRDT_EPOCH_MAX_DELETE_SET_BYTES: "536870912",
    },
  });
  token = await harness.loginUser("epoch-client");
  const vault = await harness.createVault(token, "epoch-rollover");
  vaultId = vault.id;
  ({ plugin } = makeFakePlugin(harness.authUrl, {
    sessionToken: token,
    activeVaultId: vaultId,
  }));
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

afterEach(() => {
  setEpochProposalHandler(null);
  resetDocumentEpochStateForTests();
  resetMuxForTests();
});

async function tokenEpoch(documentId: string): Promise<number> {
  return (await plugin.auth.docToken(vaultId, documentId)).epoch ?? 0;
}

describe("document epoch rollover (tier-2)", () => {
  it("replaces both real mux clients, preserves content, and accepts later writes", async () => {
    resetTokenRetryStateForTests(20);
    const documentId = `${vaultId}__${freshGuid()}`;
    const clients: EpochClient[] = [];
    let restartQueued = false;

    setEpochProposalHandler((proposedDocumentId, epoch) => {
      if (proposedDocumentId !== documentId) return;
      if (!setDocumentEpoch(plugin as any, documentId, epoch) || restartQueued) return;
      restartQueued = true;
      window.setTimeout(() => {
        for (const client of clients) client.rebuild();
        restartQueued = false;
      }, 0);
    });

    const first = new EpochClient(documentId);
    const second = new EpochClient(documentId);
    clients.push(first, second);
    const originalDocs = clients.map((client) => client.doc);

    try {
      await waitFor(() => clients.every((client) => client.provider.status === "connected"), {
        label: "epoch clients connected",
      });

      first.text.insert(0, "alpha");
      await waitFor(() => second.text.toString() === "alpha", { label: "first update converged" });
      second.text.insert(second.text.length, " beta");

      await waitFor(async () => (await tokenEpoch(documentId)) === 1, {
        label: "server activated epoch one",
        timeout: 20_000,
      });
      await waitFor(
        () =>
          clients.every(
            (client, index) =>
              client.doc !== originalDocs[index] &&
              client.provider.status === "connected" &&
              client.text.toString() === "alpha beta",
          ),
        { label: "fresh clients synchronized replacement epoch", timeout: 20_000 },
      );

      first.text.insert(first.text.length, " after");
      await waitFor(() => second.text.toString() === "alpha beta after", {
        label: "post-rollover update converged",
      });
      expect(first.text.toString()).toBe("alpha beta after");
    } finally {
      for (const client of clients) client.destroy();
    }
  }, 60_000);
});
