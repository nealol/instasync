import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as Y from "yjs";
import { YSweetProvider } from "@y-sweet/client";
import { VaultSync } from "../../src/VaultSync";
import { getClientToken } from "../../src/ysweet";
import { startAuthHarness, type AuthHarness } from "../support/authServer";
import { makeFakePlugin, type FakePlugin } from "../support/fakePlugin";
import { waitFor } from "../support/util";

let harness: AuthHarness;
let aliceToken: string;

beforeAll(async () => {
  harness = await startAuthHarness();
  aliceToken = await harness.loginUser("alice");
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

/** A bare peer onto the shared vault index (the path -> guid `files` map). */
function makeIndexPeer(plugin: FakePlugin, vaultId: string) {
  const doc = new Y.Doc();
  const provider = new YSweetProvider(
    () => getClientToken(plugin as any, vaultId) as any,
    vaultId,
    doc,
    { connect: true, showDebuggerLink: false },
  );
  return { doc, files: doc.getMap<string>("files"), provider };
}

describe("VaultSync index", () => {
  it("propagates create / delete / rename through namespaced docs", async () => {
    const vault = await harness.createVault(aliceToken, "notes");
    const vaultId = vault.id;
    const { plugin, vault: localVault } = makeFakePlugin(harness.authUrl, {
      sessionToken: aliceToken,
      activeVaultId: vaultId,
    });
    const peer = makeIndexPeer(plugin, vaultId);

    localVault.files.set("a.md", "alpha"); // one pre-existing file
    const sync = new VaultSync(plugin as any);

    try {
      // Initial sync registers the existing file and propagates to the peer.
      await waitFor(() => peer.files.has("a.md"), { timeout: 20_000, label: "a.md indexed" });

      // The file doc is reachable under the namespaced id `${vaultId}__${guid}`.
      const guid = peer.files.get("a.md")!;
      const fileDoc = new Y.Doc();
      const fileProvider = new YSweetProvider(
        () => getClientToken(plugin as any, `${vaultId}__${guid}`) as any,
        `${vaultId}__${guid}`,
        fileDoc,
        { connect: true, showDebuggerLink: false },
      );
      try {
        await waitFor(() => fileDoc.getText("contents").toString() === "alpha", {
          timeout: 20_000,
          label: "namespaced file doc has content",
        });
      } finally {
        fileProvider.destroy();
        fileDoc.destroy();
      }

      // Local create propagates.
      await localVault.create("b.md", "bravo");
      await waitFor(() => peer.files.has("b.md"), { label: "b.md indexed" });

      // A conflict-copy file must NOT be indexed / synced.
      await localVault.create("a (conflicted copy Brave Otter 2026-06-02 120000).md", "x");
      await new Promise((r) => setTimeout(r, 400));
      const indexedConflict = [...peer.files.keys()].some((p) => /conflicted copy/.test(p));
      expect(indexedConflict).toBe(false);

      // Delete removes the entry.
      const bFile = localVault.getAbstractFileByPath("b.md")!;
      await localVault.delete(bFile);
      await waitFor(() => !peer.files.has("b.md"), { label: "b.md unindexed" });

      // Rename moves the entry.
      localVault.rename("a.md", "c.md");
      await waitFor(() => peer.files.has("c.md") && !peer.files.has("a.md"), {
        label: "a.md -> c.md",
      });
    } finally {
      sync.destroy();
      peer.provider.destroy();
      peer.doc.destroy();
    }
  });

  it("publishes tracked renames as one atomic index transaction", async () => {
    const vault = await harness.createVault(aliceToken, "atomic-rename");
    const vaultId = vault.id;
    const { plugin, vault: localVault } = makeFakePlugin(harness.authUrl, {
      sessionToken: aliceToken,
      activeVaultId: vaultId,
    });
    localVault.files.set("a.md", "alpha");
    const sync = new VaultSync(plugin as any);
    try {
      const files = (sync as any).files as Y.Map<string>;
      await waitFor(() => files.has("a.md"), { timeout: 20_000, label: "a.md indexed" });

      const events: Array<Array<{ path: string; action: string }>> = [];
      files.observe((event) => {
        events.push(
          [...event.changes.keys.entries()].map(([path, change]) => ({
            path,
            action: change.action,
          })),
        );
      });

      localVault.rename("a.md", "c.md");
      await waitFor(() => files.has("c.md") && !files.has("a.md"), { label: "a.md -> c.md" });

      expect(
        events.some((event) => event.length === 1 && event[0].path === "a.md" && event[0].action === "delete"),
      ).toBe(false);
      expect(
        events.some(
          (event) =>
            event.some((change) => change.path === "a.md" && change.action === "delete") &&
            event.some((change) => change.path === "c.md" && change.action === "add"),
        ),
      ).toBe(true);
    } finally {
      sync.destroy();
    }
  });

  it("cleans up old cross-type index entries when a pending rename aborts", async () => {
    const vault = await harness.createVault(aliceToken, "cross-type-rename-abort");
    const vaultId = vault.id;
    const { plugin, vault: localVault } = makeFakePlugin(harness.authUrl, {
      sessionToken: aliceToken,
      activeVaultId: vaultId,
    });
    localVault.files.set("Board.canvas", JSON.stringify({ nodes: [], edges: [] }));
    const sync = new VaultSync(plugin as any);
    let releaseRead!: () => void;
    const blockedRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    try {
      const structured = (sync as any).structured as Y.Map<{ guid: string; kind: string }>;
      const files = (sync as any).files as Y.Map<string>;
      await waitFor(() => structured.has("Board.canvas"), {
        timeout: 20_000,
        label: "Board.canvas structured index",
      });

      const originalRead = localVault.read.bind(localVault);
      localVault.read = async (file) => {
        if (file.path === "Board.md") {
          await blockedRead;
        }
        return originalRead(file);
      };

      localVault.rename("Board.canvas", "Board.md");
      await waitFor(() => !structured.has("Board.canvas"), {
        label: "old structured entry cleaned before pending text publish",
      });

      const renamed = localVault.getAbstractFileByPath("Board.md");
      if (renamed) await localVault.delete(renamed);
      releaseRead();
      await new Promise((r) => setTimeout(r, 50));

      expect(structured.has("Board.canvas")).toBe(false);
      expect(files.has("Board.md")).toBe(false);
    } finally {
      releaseRead();
      sync.destroy();
    }
  });

  it("refuses a token to a non-member of the vault", async () => {
    const vault = await harness.createVault(aliceToken, "private");
    const bobToken = await harness.loginUser("bob");
    const { plugin } = makeFakePlugin(harness.authUrl, {
      sessionToken: bobToken,
      activeVaultId: vault.id,
    });

    await expect(getClientToken(plugin as any, vault.id)).rejects.toThrow();
  });

  it("unregisters vault event handlers when destroyed", async () => {
    const vault = await harness.createVault(aliceToken, "cleanup");
    const { plugin, vault: localVault } = makeFakePlugin(harness.authUrl, {
      sessionToken: aliceToken,
      activeVaultId: vault.id,
    });

    const sync = new VaultSync(plugin as any);
    expect(localVault.handlerCount("create")).toBe(1);
    expect(localVault.handlerCount("delete")).toBe(1);
    expect(localVault.handlerCount("rename")).toBe(1);
    expect(localVault.handlerCount("modify")).toBe(1);

    sync.destroy();
    expect(localVault.handlerCount("create")).toBe(0);
    expect(localVault.handlerCount("delete")).toBe(0);
    expect(localVault.handlerCount("rename")).toBe(0);
    expect(localVault.handlerCount("modify")).toBe(0);
  });

  it("replaces an existing queued document when the same path gets a new guid", () => {
    const sync = Object.create(VaultSync.prototype) as any;
    const oldDoc = { guid: "old-guid", destroy: vi.fn() };
    sync.destroyed = false;
    sync.documents = new Map([["same.md", oldDoc]]);
    sync.structuredDocuments = new Map();
    sync.docQueue = new Map([["same.md", { path: "same.md", guid: "queued-old", kind: "text" }]]);
    sync.prioritizedPaths = new Set();

    sync.enqueueDoc({ path: "same.md", guid: "new-guid", kind: "text" });

    expect(oldDoc.destroy).toHaveBeenCalledTimes(1);
    expect(sync.documents.has("same.md")).toBe(false);
    expect(sync.docQueue.get("same.md")).toEqual({
      path: "same.md",
      guid: "new-guid",
      kind: "text",
    });
  });
});
