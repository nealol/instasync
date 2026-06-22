// Tier-2 end-to-end coverage for single-socket sync ("Option A"): real Rust
// server (with the `/dmux` route) + real y-sweet, driving the actual
// `MuxWebSocket` polyfill through `YSweetProvider`.
//
// Like the other tier-2 suites this spawns servers and is NOT run in cloud CI
// (the plugin project is disabled there); run it locally via `bun run test:unit`.
//
// The two scenarios here are the ones unit tests with a fake socket can't reach:
//   1. N documents collapse to ONE real socket and sync both directions.
//   2. When that single socket drops, every provider reconnects and resyncs.
//
// Write attribution through the demux (git/search/plugin-db) is exercised by the
// wdio Obsidian e2e (it has the git/cr-sqlite infra); the demux reuses the same
// `is_content_write`/`mark_content_write` tap the `/d` proxy is tested against.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as Y from "yjs";
import { YSweetProvider } from "@y-sweet/client";
import { makeFakePlugin, type FakePlugin } from "../support/fakePlugin";
import { Peer } from "../support/peer";
import { startAuthHarness, type AuthHarness } from "../support/authServer";
import { waitFor, freshGuid } from "../support/util";
import { getClientToken, resetTokenRetryStateForTests } from "../../src/ysweet";
import { muxProviderOptions } from "../../src/sync/wsPolyfill";
import { resetMuxForTests, setMuxWebSocketCtor } from "../../src/sync/mux";

let harness: AuthHarness;
let token: string;
let vaultId: string;
let plugin: FakePlugin;

// A real WebSocket subclass that records every `/dmux` socket the mux opens, so
// the test can assert all providers share exactly one (and a fresh one appears
// after a drop). Peers use the plain global socket and are not counted.
const RealWebSocket = globalThis.WebSocket as unknown as { new (url: string): WebSocket };
let opened: string[] = [];
class CountingWebSocket extends (RealWebSocket as any) {
  static instances: any[] = [];
  constructor(url: string) {
    super(url);
    opened.push(url);
    CountingWebSocket.instances.push(this);
  }
}

beforeAll(async () => {
  harness = await startAuthHarness();
  token = await harness.loginUser("alice");
  const vault = await harness.createVault(token, "mux");
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
  resetMuxForTests();
});

/** A provider for `serverDocId` routed through the always-on single-socket mux. */
function muxProvider(serverDocId: string): {
  doc: Y.Doc;
  text: Y.Text;
  provider: YSweetProvider;
  destroy: () => void;
} {
  const doc = new Y.Doc();
  const text = doc.getText("contents");
  const provider = new YSweetProvider(
    () => getClientToken(plugin as any, serverDocId) as any,
    serverDocId,
    doc,
    { connect: true, showDebuggerLink: false, ...muxProviderOptions() },
  );
  return {
    doc,
    text,
    provider,
    destroy: () => {
      provider.destroy();
      doc.destroy();
    },
  };
}

const fileDocId = (guid: string) => `${vaultId}__${guid}`;

describe("single-socket sync (tier-2)", () => {
  it("carries multiple docs over one real socket and syncs both directions", async () => {
    opened = [];
    CountingWebSocket.instances = [];
    setMuxWebSocketCtor(CountingWebSocket as unknown as { new (url: string): WebSocket });
    resetTokenRetryStateForTests(50);

    const idA = fileDocId(freshGuid());
    const idB = fileDocId(freshGuid());
    const a = muxProvider(idA);
    const b = muxProvider(idB);
    const peerA = new Peer(plugin, idA);
    const peerB = new Peer(plugin, idB);
    try {
      await waitFor(() => a.provider.status === "connected" && b.provider.status === "connected", {
        label: "both mux providers connected",
      });
      await peerA.whenSynced();
      await peerB.whenSynced();

      // The core claim of Option A: N documents → ONE client socket to /dmux.
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatch(/\/dmux$/);

      // mux -> server -> peer, on each independent channel.
      a.text.insert(0, "hello A");
      b.text.insert(0, "hello B");
      await waitFor(() => peerA.getText() === "hello A", { label: "docA synced mux->peer" });
      await waitFor(() => peerB.getText() === "hello B", { label: "docB synced mux->peer" });

      // peer -> server -> mux, and channels must not cross-talk.
      peerB.setText("peer wrote B");
      await waitFor(() => b.text.toString() === "peer wrote B", {
        label: "docB synced peer->mux",
      });
      expect(a.text.toString()).toBe("hello A");

      // Still exactly one real socket after all the traffic.
      expect(opened).toHaveLength(1);
    } finally {
      a.destroy();
      b.destroy();
      peerA.destroy();
      peerB.destroy();
    }
  });

  it("reconnects and resyncs after the shared socket drops", async () => {
    opened = [];
    CountingWebSocket.instances = [];
    setMuxWebSocketCtor(CountingWebSocket as unknown as { new (url: string): WebSocket });
    resetTokenRetryStateForTests(50);

    const id = fileDocId(freshGuid());
    const a = muxProvider(id);
    const peer = new Peer(plugin, id);
    try {
      await waitFor(() => a.provider.status === "connected", { label: "mux provider connected" });
      await peer.whenSynced();

      a.text.insert(0, "before drop");
      await waitFor(() => peer.getText() === "before drop", { label: "initial sync" });
      expect(opened).toHaveLength(1);

      // Hard-kill the one real socket. The mux fans the drop out to the channel,
      // the provider reconnects, and the mux opens a fresh /dmux socket.
      const sock = CountingWebSocket.instances.at(-1);
      if (typeof sock.terminate === "function") sock.terminate();
      else sock.close();

      await waitFor(() => opened.length >= 2, { label: "reconnect opens a new socket" });
      await waitFor(() => a.provider.status === "connected", { label: "provider reconnected" });

      // An edit after the drop must still round-trip (resync succeeded).
      a.text.insert(a.text.length, " + after drop");
      await waitFor(() => peer.getText() === "before drop + after drop", {
        label: "resync after reconnect",
      });
    } finally {
      a.destroy();
      peer.destroy();
    }
  });
});
