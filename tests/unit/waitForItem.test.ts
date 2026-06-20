import { describe, it, expect, vi, afterEach } from "vitest";
import * as Y from "yjs";
import { TFile } from "obsidian";
import { VaultSync } from "../../src/VaultSync";

/**
 * Build a bare {@link VaultSync} without invoking its constructor (so no
 * network, IndexedDB, or providers). Only the slices `waitForItem` touches are
 * wired: the shared `files`/`structured` Y.Maps, the `destroyed` flag, and a
 * fake vault whose `getAbstractFileByPath` is backed by an `onDisk` set the
 * test can mutate to simulate the Document pipeline's disk write.
 */
function makeFixture(): VaultSync & { onDisk: Set<string> } {
  const sync = Object.create(VaultSync.prototype) as unknown as VaultSync;
  const doc = new Y.Doc();
  sync["files"] = doc.getMap<string>("files");
  sync["structured"] = doc.getMap("structured");
  sync["destroyed"] = false;
  const onDisk = new Set<string>();
  sync["plugin"] = {
    app: {
      vault: {
        getAbstractFileByPath: (p: string): TFile | null =>
          onDisk.has(p) ? new TFile(p) : null,
      },
    },
  } as any;
  return Object.assign(sync, { onDisk });
}

// Fake timers leak across tests; reset after each so the immediate-hit cases
// (which use real timers) run untouched.
afterEach(() => {
  vi.useRealTimers();
});

describe("VaultSync.waitForItem", () => {
  it("resolves synchronously when the guid is indexed and the file is on disk", async () => {
    const sync = makeFixture();
    sync["files"].set("note.md", "g1");
    sync.onDisk.add("note.md");

    const file = await sync.waitForItem({ guid: "g1" });

    expect(file).toBeInstanceOf(TFile);
    expect(file?.path).toBe("note.md");
  });

  it("resolves immediately for a path-only link when the file is on disk", async () => {
    const sync = makeFixture();
    sync.onDisk.add("explicit.md");

    const file = await sync.waitForItem({ path: "explicit.md" });

    expect(file).toBeInstanceOf(TFile);
    expect(file?.path).toBe("explicit.md");
  });

  it("keeps waiting when the index arrives before the disk write, then resolves", async () => {
    vi.useFakeTimers();
    const sync = makeFixture();
    const promise = sync.waitForItem({ guid: "g1" });
    let resolved: TFile | null | undefined = undefined;
    promise.then((r) => {
      resolved = r;
    });

    // Index entry arrives (observer fires synchronously): path resolves, but the
    // file is not on disk yet → must keep waiting (both-conditions rule).
    sync["files"].set("note.md", "g1");
    await vi.advanceTimersByTimeAsync(250); // poll fires; still no disk file
    expect(resolved).toBeUndefined();

    // Disk write lands; the next poll tick picks it up.
    sync.onDisk.add("note.md");
    await vi.advanceTimersByTimeAsync(250);

    expect(resolved).toBeInstanceOf(TFile);
    expect(resolved?.path).toBe("note.md");
  });

  it("re-resolves a guid that only appears in the index after the wait starts", async () => {
    vi.useFakeTimers();
    const sync = makeFixture();
    // pathForGuid("g1") is null at call time (files map empty).
    const promise = sync.waitForItem({ guid: "g1" });

    // The guid maps to a path only once the index merges; each tick re-resolves.
    sync["files"].set("late.md", "g1");
    sync.onDisk.add("late.md");
    await vi.advanceTimersByTimeAsync(250);

    const file = await promise;
    expect(file).toBeInstanceOf(TFile);
    expect(file?.path).toBe("late.md");
  });

  it("resolves null on timeout and cleans up its timer and observers", async () => {
    vi.useFakeTimers();
    const sync = makeFixture();
    const vault = sync["plugin"].app.vault;
    const getSpy = vi.spyOn(vault, "getAbstractFileByPath");

    const promise = sync.waitForItem({ guid: "g1", timeoutMs: 15_000 });
    let resolved: TFile | null | undefined = undefined;
    promise.then((r) => {
      resolved = r;
    });

    await vi.advanceTimersByTimeAsync(15_500);
    expect(resolved).toBeNull();

    // Cleanup verification: after the timeout, neither a poll tick nor an index
    // mutation re-invokes check() (which would call getAbstractFileByPath).
    const callsAfterTimeout = getSpy.mock.calls.length;
    sync["files"].set("note.md", "g1");
    sync.onDisk.add("note.md");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(resolved).toBeNull();
    expect(getSpy.mock.calls.length).toBe(callsAfterTimeout);
  });

  it("resolves null promptly when the sync is destroyed mid-wait", async () => {
    vi.useFakeTimers();
    const sync = makeFixture();
    const promise = sync.waitForItem({ guid: "g1" });
    let resolved: TFile | null | undefined = undefined;
    promise.then((r) => {
      resolved = r;
    });

    sync["destroyed"] = true;
    await vi.advanceTimersByTimeAsync(250); // next poll tick detects destroy

    expect(resolved).toBeNull();
  });

  it("detaches observers after resolution so further index changes do not re-check", async () => {
    vi.useFakeTimers();
    const sync = makeFixture();
    const vault = sync["plugin"].app.vault;
    const getSpy = vi.spyOn(vault, "getAbstractFileByPath");

    const promise = sync.waitForItem({ guid: "g1" });
    // Index + disk arrive after the wait starts (observer attaches, then resolves).
    sync["files"].set("note.md", "g1");
    sync.onDisk.add("note.md");
    await vi.advanceTimersByTimeAsync(250);
    const file = await promise;
    expect(file).toBeInstanceOf(TFile);

    // After resolution the observers must be detached: mutating the index must
    // not re-invoke check() (which would call getAbstractFileByPath), and the
    // idempotent finish guard means no throw even if it did.
    const callsAfterResolve = getSpy.mock.calls.length;
    expect(() => sync["files"].set("other.md", "g2")).not.toThrow();
    expect(getSpy.mock.calls.length).toBe(callsAfterResolve);
  });
});
