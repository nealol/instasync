import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  ConfigSync,
  decideConfigReconcile,
  mergeJsonSettings,
  type ConfigMeta,
} from "../../src/ConfigSync";
import { LocalSyncState } from "../../src/localSyncState";
import { makeFakePlugin } from "../support/fakePlugin";
import { freshGuid } from "../support/util";
import { waitFor } from "../support/util";

const local: ConfigMeta = { hash: "local", size: 1, mtime: 200 };
const remote: ConfigMeta = { hash: "remote", size: 1, mtime: 100 };

describe("ConfigSync reconcile decisions", () => {
  it("resumes an interrupted first pull without publishing a remote delete", async () => {
    const { plugin } = makeFakePlugin("https://sync.example.com", {
      sessionToken: "token",
      activeVaultId: "vault",
    });
    const indexDoc = new Y.Doc();
    const remote = { hash: "remote-hash", size: 1, mtime: 1 };
    indexDoc.getMap<ConfigMeta>("configFiles").set(".obsidian/appearance.json", remote);
    const sync = new ConfigSync(plugin as any, indexDoc);
    (sync as any).lastSyncedHash.set(".obsidian/appearance.json", remote.hash);
    let release!: () => void;
    let passes = 0;
    vi.spyOn(sync, "reconcileAll").mockImplementation(async () => {
      passes += 1;
      if (passes === 1) await new Promise<void>((resolve) => (release = resolve));
      else {
        const action = decideConfigReconcile(null, remote, remote.hash, {
          initialPull: (sync as any).initialPull,
        });
        if (action === "deleteRemote") {
          indexDoc.getMap("configFiles").delete(".obsidian/appearance.json");
        }
      }
    });
    try {
      sync.start(new Set(["appearance"] as any));
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      sync.setPaused(true);
      release();
      await Promise.resolve();
      sync.setPaused(false);
      await vi.waitFor(() => expect(passes).toBe(2));
      expect(indexDoc.getMap("configFiles").has(".obsidian/appearance.json")).toBe(true);
    } finally {
      sync.destroy();
      indexDoc.destroy();
    }
  });

  it("defers config reconciliation while paused and scans on resume", async () => {
    const { plugin } = makeFakePlugin("https://sync.example.com", {
      sessionToken: "token",
      activeVaultId: "vault",
    });
    const indexDoc = new Y.Doc();
    (plugin.app.vault as any).adapter = {
      readBinary: vi.fn(async () => new Uint8Array([1]).buffer),
      exists: vi.fn(async () => true),
      stat: vi.fn(async () => ({ mtime: 1, ctime: 1, size: 1, type: "file" })),
    };
    const sync = new ConfigSync(plugin as any, indexDoc);
    const reconcile = vi.spyOn(sync, "reconcileAll").mockResolvedValue();
    sync.setPaused(true);
    sync.start(new Set(["appearance"] as any));
    await Promise.resolve();
    expect(reconcile).not.toHaveBeenCalled();
    sync.setPaused(false);
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);
    sync.destroy();
    indexDoc.destroy();
  });

  it("does not publish an upload that was paused in flight", async () => {
    const { plugin } = makeFakePlugin("https://sync.example.com", {
      sessionToken: "token",
      activeVaultId: "vault",
    });
    const indexDoc = new Y.Doc();
    const sync = new ConfigSync(plugin as any, indexDoc);
    let release!: (exists: boolean) => void;
    plugin.auth.blobExists = vi.fn(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    );
    const upload = (sync as any).uploadBytes(
      ".obsidian/appearance.json",
      new Uint8Array([1]).buffer,
      null,
      null,
    );
    await waitFor(() => typeof release === "function", { label: "blob check started" });
    sync.setPaused(true);
    release(true);
    await upload;
    expect(indexDoc.getMap("configFiles").has(".obsidian/appearance.json")).toBe(false);
    sync.destroy();
    indexDoc.destroy();
  });

  it("does not apply a download that was paused in flight", async () => {
    const { plugin } = makeFakePlugin("https://sync.example.com", {
      sessionToken: "token",
      activeVaultId: "vault",
    });
    const indexDoc = new Y.Doc();
    const sync = new ConfigSync(plugin as any, indexDoc);
    let release!: (bytes: ArrayBuffer) => void;
    plugin.auth.getBlob = vi.fn(
      () => new Promise<ArrayBuffer>((resolve) => (release = resolve)),
    );
    const writeBinary = vi.fn(async () => undefined);
    (plugin.app.vault as any).adapter = {
      exists: vi.fn(async () => false),
      stat: vi.fn(async () => null),
      readBinary: vi.fn(),
      writeBinary,
      mkdir: vi.fn(async () => undefined),
    };
    const download = (sync as any).download(
      ".obsidian/appearance.json",
      { hash: "remote", size: 1, mtime: 1 },
      null,
    );
    await waitFor(() => typeof release === "function", { label: "config download started" });
    sync.setPaused(true);
    release(new Uint8Array([1]).buffer);
    await download;
    expect(writeBinary).not.toHaveBeenCalled();
    sync.destroy();
    indexDoc.destroy();
  });

  it("retains a durable config baseline after the remote map deletion has persisted", async () => {
    const { plugin } = makeFakePlugin("https://sync.example.com", {
      sessionToken: "token",
      activeVaultId: "vault",
    });
    const localState = new LocalSyncState(`config-delete:${freshGuid()}`);
    await localState.whenSynced;
    localState.markSynced(".obsidian/appearance.json", "config", "old-hash", "old-hash");
    const indexDoc = new Y.Doc();
    const sync = new ConfigSync(plugin as any, indexDoc, localState);
    try {
      sync.seedBaseline();
      expect((sync as any).lastSyncedHash.get(".obsidian/appearance.json")).toBe("old-hash");
    } finally {
      sync.destroy();
      indexDoc.destroy();
      localState.destroy();
    }
  });

  it("migrates a legacy config marker into the persisted index baseline", async () => {
    const { plugin } = makeFakePlugin("https://sync.example.com", {
      sessionToken: "token",
      activeVaultId: "vault",
    });
    const localState = new LocalSyncState(`config-legacy:${freshGuid()}`);
    await localState.whenSynced;
    localState.mark(".obsidian/appearance.json", "config");
    const indexDoc = new Y.Doc();
    indexDoc
      .getMap<ConfigMeta>("configFiles")
      .set(".obsidian/appearance.json", { hash: "remote-hash", size: 1, mtime: 1 });
    const sync = new ConfigSync(plugin as any, indexDoc, localState);
    try {
      sync.seedBaseline();
      expect((sync as any).lastSyncedHash.get(".obsidian/appearance.json")).toBe(
        "remote-hash",
      );
    } finally {
      sync.destroy();
      indexDoc.destroy();
      localState.destroy();
    }
  });

  it("downloads remote config on a fresh device when both sides exist", () => {
    expect(decideConfigReconcile(local, remote, null)).toBe("download");
  });

  it("downloads a remote file this device has never pulled (no baseline)", () => {
    expect(decideConfigReconcile(null, remote, null)).toBe("download");
  });

  it("propagates a local delete once the initial pull is done", () => {
    expect(decideConfigReconcile(null, remote, remote.hash)).toBe("deleteRemote");
  });

  it("never publishes a delete during the initial pull (seeded baselines lie)", () => {
    expect(decideConfigReconcile(null, remote, remote.hash, { initialPull: true })).toBe(
      "download",
    );
  });

  it("downloads instead of deleting when remote moved past our delete baseline", () => {
    expect(decideConfigReconcile(null, remote, "older")).toBe("download");
  });

  it("deletes locally when the remote entry vanished and local matches baseline", () => {
    expect(decideConfigReconcile(local, null, local.hash)).toBe("deleteLocal");
  });

  it("keeps (re-uploads) local edits when remote deleted a file we changed", () => {
    expect(decideConfigReconcile(local, null, "older")).toBe("upload");
  });

  it("resolves clean one-sided edits from the baseline", () => {
    expect(decideConfigReconcile(local, remote, remote.hash)).toBe("upload");
    expect(decideConfigReconcile(local, remote, local.hash)).toBe("download");
  });

  it("merges true conflicts on JSON settings files", () => {
    expect(decideConfigReconcile(local, remote, "older", { canMerge: true })).toBe("merge");
  });

  it("falls back to newest-wins on non-mergeable conflicts", () => {
    expect(decideConfigReconcile(local, remote, "older")).toBe("upload");
    const olderLocal = { ...local, mtime: 50 };
    expect(decideConfigReconcile(olderLocal, remote, "older")).toBe("download");
  });
});

describe("mergeJsonSettings", () => {
  it("applies local keys on top of remote keys", () => {
    const merged = mergeJsonSettings(
      JSON.stringify({ theme: "obsidian", fontSize: 14 }),
      JSON.stringify({ fontSize: 18, spellcheck: true }),
    );
    expect(merged).not.toBeNull();
    expect(JSON.parse(merged as string)).toEqual({
      theme: "obsidian",
      fontSize: 18,
      spellcheck: true,
    });
  });

  it("returns null for non-object JSON so callers fall back to newest-wins", () => {
    expect(mergeJsonSettings("[1,2]", "{}")).toBeNull();
    expect(mergeJsonSettings("{}", '"str"')).toBeNull();
    expect(mergeJsonSettings("not json", "{}")).toBeNull();
  });
});
