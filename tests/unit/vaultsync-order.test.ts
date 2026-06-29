import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { VaultSync } from "../../src/VaultSync";
import { makeFakePlugin, type FakeVault } from "../support/fakePlugin";
import { notices } from "../support/obsidian-mock";
import { startAuthHarness, type AuthHarness } from "../support/authServer";
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

afterEach(() => {
  notices.length = 0;
});

/** A single-node canvas whose seeded content is identifiable from disk writes. */
const SEEDED_CANVAS = JSON.stringify({
  nodes: [{ id: "n1", type: "text", text: "seeded-node", x: 10, y: 20 }],
  edges: [],
});

/**
 * Record every text written to `path` on a fake vault (create + modify), so a
 * test can assert a peer never materialized an empty file before the real
 * content arrived.
 */
function recordWrites(vault: FakeVault, path: string): string[] {
  const writes: string[] = [];
  const origCreate = vault.create.bind(vault);
  const origModify = vault.modify.bind(vault);
  vault.create = async (p: string, text: string) => {
    if (p === path) writes.push(text);
    return origCreate(p, text);
  };
  vault.modify = async (file: { path: string }, text: string) => {
    if (file?.path === path) writes.push(text);
    return origModify(file, text);
  };
  return writes;
}

/**
 * Slow the creator's disk read for `path`. The creator seeds its CRDT from
 * disk inside `whenReady()`; by stalling that read we open a wide window
 * where, if the index entry is published *before* `whenReady()` resolves, the
 * peer connects to an empty doc and writes an empty file. This makes the
 * ordering guarantee deterministic to test rather than a tight localhost race.
 */
function delayCreatorRead(vault: FakeVault, path: string, ms = 600): void {
  const origRead = vault.read.bind(vault);
  vault.read = async (file: { path: string }) => {
    if (file?.path === path) await new Promise((r) => setTimeout(r, ms));
    return origRead(file);
  };
}

/**
 * The invariant under test: a creator must seed its structured doc and let it
 * sync before publishing the path to the shared index. Otherwise a peer that
 * sees the index entry connects to an empty doc and writes an empty file to
 * disk before the real content lands. We assert the peer only ever writes the
 * seeded content (never an empty canvas), which is the user-visible behavior
 * the `await doc.whenReady()` before `this.structured.set(...)` guarantees.
 */
async function expectPeerReceivesSeed(
  a: ReturnType<typeof makeFakePlugin>,
  b: ReturnType<typeof makeFakePlugin>,
  path: string,
): Promise<void> {
  const bWrites = recordWrites(b.vault, path);
  const syncA = new VaultSync(a.plugin as any);
  const syncB = new VaultSync(b.plugin as any);
  try {
    await waitFor(() => b.vault.files.has(path), {
      timeout: 30_000,
      label: `${path} reached peer`,
    });

    // The peer's disk has the seeded node...
    const disk = b.vault.files.get(path)!;
    expect(disk).toContain("seeded-node");

    // ...and it never wrote an empty canvas along the way. Every write carries
    // the seeded content, proving the index entry arrived after the doc was
    // seeded rather than before.
    expect(bWrites.length).toBeGreaterThan(0);
    for (const text of bWrites) {
      expect(text).toContain("seeded-node");
    }
  } finally {
    syncA.destroy();
    syncB.destroy();
  }
}

describe("VaultSync publish ordering", () => {
  it("seeds a pre-existing structured file before publishing it to the index", async () => {
    const vault = await harness.createVault(aliceToken, "ordering-scan");
    const a = makeFakePlugin(harness.authUrl, {
      sessionToken: aliceToken,
      activeVaultId: vault.id,
      clientName: "A",
    });
    const b = makeFakePlugin(harness.authUrl, {
      sessionToken: aliceToken,
      activeVaultId: vault.id,
      clientName: "B",
    });
    // Place the file before construction so it is picked up by the initial
    // sync's "add any local structured files not tracked yet" pass. Slow the
    // creator's disk read so a missing `await whenReady()` deterministically
    // lets the peer race ahead and materialize an empty file.
    a.vault.files.set("Board.canvas", SEEDED_CANVAS);
    delayCreatorRead(a.vault, "Board.canvas");

    await expectPeerReceivesSeed(a, b, "Board.canvas");
  });

  it("seeds a newly created structured file before publishing it to the index", async () => {
    const vault = await harness.createVault(aliceToken, "ordering-create");
    const a = makeFakePlugin(harness.authUrl, {
      sessionToken: aliceToken,
      activeVaultId: vault.id,
      clientName: "A",
    });
    const b = makeFakePlugin(harness.authUrl, {
      sessionToken: aliceToken,
      activeVaultId: vault.id,
      clientName: "B",
    });

    // Construct both peers first, then wait for their initial syncs to finish
    // (each fires a "connected, syncing" notice at the end of runInitialSync)
    // so the local create takes the handleLocalCreate path rather than the
    // initial-scan path.
    const syncA = new VaultSync(a.plugin as any);
    const syncB = new VaultSync(b.plugin as any);
    try {
      await waitFor(() => notices.filter((n) => /connected, syncing/.test(n)).length >= 2, {
        timeout: 30_000,
        label: "both peers finished initial sync",
      });

      // Drive the create through the vault event so VaultSync's onLocalCreate
      // runs the creator path (ensureStructuredDocument -> whenReady -> set).
      // Slow the creator's disk read so a missing `await whenReady()`
      // deterministically lets the peer race ahead and materialize an empty
      // file.
      delayCreatorRead(a.vault, "Board.canvas");
      await a.vault.create("Board.canvas", SEEDED_CANVAS);

      const bWrites = recordWrites(b.vault, "Board.canvas");
      await waitFor(() => b.vault.files.has("Board.canvas"), {
        timeout: 30_000,
        label: "Board.canvas reached peer",
      });
      expect(b.vault.files.get("Board.canvas")).toContain("seeded-node");
      expect(bWrites.length).toBeGreaterThan(0);
      for (const text of bWrites) {
        expect(text).toContain("seeded-node");
      }
    } finally {
      syncA.destroy();
      syncB.destroy();
    }
  });

  it("seeds a newly created text file before publishing a pending-create rename", async () => {
    const vault = await harness.createVault(aliceToken, "ordering-create-rename");
    const a = makeFakePlugin(harness.authUrl, {
      sessionToken: aliceToken,
      activeVaultId: vault.id,
      clientName: "A",
    });
    const b = makeFakePlugin(harness.authUrl, {
      sessionToken: aliceToken,
      activeVaultId: vault.id,
      clientName: "B",
    });

    const syncA = new VaultSync(a.plugin as any);
    const syncB = new VaultSync(b.plugin as any);
    try {
      await waitFor(() => notices.filter((n) => /connected, syncing/.test(n)).length >= 2, {
        timeout: 30_000,
        label: "both peers finished initial sync",
      });

      const path = "Renamed.md";
      const content = "seeded note body";
      const bWrites = recordWrites(b.vault, path);

      // Keep the creator doc unseeded long enough that publishing the rename
      // immediately would let the peer materialize an empty note at Renamed.md.
      delayCreatorRead(a.vault, "Draft.md");
      delayCreatorRead(a.vault, path);
      await a.vault.create("Draft.md", content);
      a.vault.rename("Draft.md", path);

      await waitFor(() => b.vault.files.get(path) === content, {
        timeout: 30_000,
        label: "renamed text file reached peer with content",
      });
      expect(b.vault.files.has("Draft.md")).toBe(false);
      expect(bWrites.length).toBeGreaterThan(0);
      for (const text of bWrites) {
        expect(text).toBe(content);
      }
    } finally {
      syncA.destroy();
      syncB.destroy();
    }
  });
});
