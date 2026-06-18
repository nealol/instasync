import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as Y from "yjs";
import { YSweetProvider } from "@y-sweet/client";
import { BinarySync, type BinaryMeta } from "../../src/BinarySync";
import { getClientToken } from "../../src/ysweet";
import { makeFakePlugin } from "../support/fakePlugin";
import { notices } from "../support/obsidian-mock";
import { startAuthHarness, type AuthHarness } from "../support/authServer";
import { waitFor } from "../support/util";

let harness: AuthHarness;
let token: string;
let vaultId: string;

beforeAll(async () => {
  harness = await startAuthHarness();
  token = await harness.loginUser("alice");
  const vault = await harness.createVault(token, "attachments");
  vaultId = vault.id;
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

afterEach(() => {
  notices.length = 0;
});

const bytes = (arr: number[]) => new Uint8Array(arr).buffer;
const asArray = (buf: ArrayBuffer | undefined) => (buf ? [...new Uint8Array(buf)] : null);

/** A "device": fake vault + an index doc/provider + a BinarySync over it. */
function makeDevice(name: string) {
  const { plugin, vault } = makeFakePlugin(harness.authUrl, {
    sessionToken: token,
    activeVaultId: vaultId,
    clientName: name,
  });
  const indexDoc = new Y.Doc();
  const provider = new YSweetProvider(
    () => getClientToken(plugin as any, vaultId) as any,
    vaultId,
    indexDoc,
    { connect: true, showDebuggerLink: false },
  );
  // Record the upload-status transitions the plugin would render.
  const uploadStates: string[] = [];
  plugin.setUploadStatus = (v: string) => uploadStates.push(v);
  // BinarySync needs isTextSyncBusy() (tests can flip it) and recordTrash().
  const trashed: unknown[] = [];
  const vaultSyncStub = {
    busy: false,
    isTextSyncBusy() {
      return this.busy;
    },
    recordTrash(entry: unknown) {
      trashed.push(entry);
    },
  };
  const bs = new BinarySync(plugin as any, vaultSyncStub as any, indexDoc);
  const binaries = indexDoc.getMap<BinaryMeta>("binaries");
  return { plugin, vault, indexDoc, provider, bs, binaries, uploadStates, vaultSyncStub };
}

const synced = (p: YSweetProvider) =>
  waitFor(() => p.status === "connected", { label: "provider connected" });

describe("BinarySync", () => {
  it("uploads a local binary and a peer downloads identical bytes", async () => {
    const A = makeDevice("A");
    const B = makeDevice("B");
    try {
      await synced(A.provider);
      await synced(B.provider);

      // B is online with its observer armed but has no local files.
      B.bs.seedBaseline();
      await B.bs.reconcileAll([]);

      // A creates a binary file and reconciles it (uploads + publishes hash).
      A.vault.binaries.set("img.png", bytes([1, 2, 3, 4, 5]));
      A.bs.seedBaseline();
      await A.bs.reconcileAll(["img.png"]);

      // The hash mapping propagates and B pulls the bytes from the blob store.
      await waitFor(() => B.vault.binaries.has("img.png"), {
        label: "B downloaded the blob",
      });
      expect(asArray(B.vault.binaries.get("img.png"))).toEqual([1, 2, 3, 4, 5]);

      // The published map entry carries the size.
      await waitFor(() => B.binaries.get("img.png")?.size === 5, { label: "size published" });
    } finally {
      A.bs.destroy();
      A.provider.destroy();
      A.indexDoc.destroy();
      B.bs.destroy();
      B.provider.destroy();
      B.indexDoc.destroy();
    }
  });

  it("signals uploading then idle around an upload", async () => {
    const A = makeDevice("A");
    try {
      await synced(A.provider);
      A.vault.binaries.set("small.bin", bytes([4, 5, 6, 7, 8, 9]));
      A.bs.seedBaseline();
      await A.bs.reconcileAll(["small.bin"]);

      await waitFor(() => A.uploadStates.at(-1) === "idle", { label: "upload finished" });
      expect(A.uploadStates).toContain("uploading");
      expect(A.uploadStates.at(-1)).toBe("idle");
      await waitFor(() => A.binaries.has("small.bin"), { label: "published" });
    } finally {
      A.bs.destroy();
      A.provider.destroy();
      A.indexDoc.destroy();
    }
  });

  it("restores a missing local binary from a persisted remote baseline", async () => {
    const A = makeDevice("A");
    const B = makeDevice("B");
    try {
      await synced(A.provider);
      await synced(B.provider);

      A.vault.binaries.set("image.png", bytes([7, 6, 5, 4]));
      A.bs.seedBaseline();
      await A.bs.reconcileAll(["image.png"]);

      await waitFor(() => B.binaries.has("image.png"), { label: "B index has image" });

      // Simulate a migrated IndexedDB baseline with no local vault file yet. This
      // must pull the blob, not interpret absence as a local delete.
      B.bs.seedBaseline();
      await B.bs.reconcileAll([]);

      await waitFor(() => B.vault.binaries.has("image.png"), { label: "B restored image" });
      expect(asArray(B.vault.binaries.get("image.png"))).toEqual([7, 6, 5, 4]);
      expect(B.binaries.has("image.png")).toBe(true);
    } finally {
      A.bs.destroy();
      A.provider.destroy();
      A.indexDoc.destroy();
      B.bs.destroy();
      B.provider.destroy();
      B.indexDoc.destroy();
    }
  });

  it("reports a large deferred file as pending while text sync is busy", async () => {
    const A = makeDevice("A");
    try {
      await synced(A.provider);
      // Pretend notes are actively syncing so large uploads are held back.
      A.vaultSyncStub.busy = true;

      // A >5MB file is queued but must not transfer yet.
      const big = new Uint8Array(6 * 1024 * 1024);
      big[0] = 1;
      A.vault.binaries.set("huge.bin", big.buffer);
      A.bs.seedBaseline();
      await A.bs.reconcileAll(["huge.bin"]);

      await waitFor(() => A.uploadStates.at(-1) === "pending", { label: "deferred -> pending" });
      expect(A.uploadStates).not.toContain("uploading");
      expect(A.binaries.has("huge.bin")).toBe(false); // not published while deferred

      // Once notes go quiet, it uploads and settles to idle.
      A.vaultSyncStub.busy = false;
      await waitFor(() => A.uploadStates.at(-1) === "idle", { timeout: 15_000, label: "drains" });
      expect(A.uploadStates).toContain("uploading");
      expect(A.binaries.has("huge.bin")).toBe(true);
    } finally {
      A.bs.destroy();
      A.provider.destroy();
      A.indexDoc.destroy();
    }
  });

  it("applies a clean remote delete to a peer's local attachment", async () => {
    const A = makeDevice("A");
    const B = makeDevice("B");
    try {
      await synced(A.provider);
      await synced(B.provider);
      B.bs.seedBaseline();
      await B.bs.reconcileAll([]);

      A.vault.binaries.set("doc.pdf", bytes([9, 8, 7]));
      A.bs.seedBaseline();
      await A.bs.reconcileAll(["doc.pdf"]);
      await waitFor(() => B.vault.binaries.has("doc.pdf"), { label: "B has the file" });

      // A deletes the file locally → the index entry is removed. B has no
      // unsynced local changes, so the remote delete is authoritative and B
      // removes its local copy too.
      A.vault.binaries.delete("doc.pdf");
      A.bs.onLocalDeleted("doc.pdf");

      await waitFor(() => !B.binaries.has("doc.pdf"), { label: "index entry gone" });
      await waitFor(() => !B.vault.binaries.has("doc.pdf"), { label: "B applied the delete" });
    } finally {
      A.bs.destroy();
      A.provider.destroy();
      A.indexDoc.destroy();
      B.bs.destroy();
      B.provider.destroy();
      B.indexDoc.destroy();
    }
  });

  it("keeps a peer attachment when remote delete races local edits (conflict)", async () => {
    const A = makeDevice("A");
    const B = makeDevice("B");
    try {
      await synced(A.provider);
      await synced(B.provider);
      B.bs.seedBaseline();
      await B.bs.reconcileAll([]);

      A.vault.binaries.set("doc.pdf", bytes([9, 8, 7]));
      A.bs.seedBaseline();
      await A.bs.reconcileAll(["doc.pdf"]);
      await waitFor(() => B.vault.binaries.has("doc.pdf"), { label: "B has the file" });

      // B edits the file locally (now diverged from the synced baseline)...
      B.vault.binaries.set("doc.pdf", bytes([1, 2, 3, 4]));

      // ...while A deletes it remotely. The delete is no longer clean, so B
      // keeps its local copy and surfaces a conflict for the user to resolve.
      A.vault.binaries.delete("doc.pdf");
      A.bs.onLocalDeleted("doc.pdf");

      await waitFor(() => !B.binaries.has("doc.pdf"), { label: "index entry gone" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(B.vault.binaries.has("doc.pdf")).toBe(true);
    } finally {
      A.bs.destroy();
      A.provider.destroy();
      A.indexDoc.destroy();
      B.bs.destroy();
      B.provider.destroy();
      B.indexDoc.destroy();
    }
  });

  it("re-downloads when a peer replaces the file (clean remote update)", async () => {
    const A = makeDevice("A");
    const B = makeDevice("B");
    try {
      await synced(A.provider);
      await synced(B.provider);
      B.bs.seedBaseline();
      await B.bs.reconcileAll([]);

      A.vault.binaries.set("photo.jpg", bytes([1, 1, 1]));
      A.bs.seedBaseline();
      await A.bs.reconcileAll(["photo.jpg"]);
      await waitFor(() => asArray(B.vault.binaries.get("photo.jpg"))?.[0] === 1, {
        label: "B has v1",
      });

      // A replaces the content; B (unchanged locally) should pull the new bytes.
      A.vault.binaries.set("photo.jpg", bytes([2, 2, 2, 2]));
      A.bs.onLocalChanged("photo.jpg");

      await waitFor(() => asArray(B.vault.binaries.get("photo.jpg"))?.length === 4, {
        label: "B has v2",
      });
      expect(asArray(B.vault.binaries.get("photo.jpg"))).toEqual([2, 2, 2, 2]);
    } finally {
      A.bs.destroy();
      A.provider.destroy();
      A.indexDoc.destroy();
      B.bs.destroy();
      B.provider.destroy();
      B.indexDoc.destroy();
    }
  });
});
