import { describe, expect, it } from "vitest";
import { decideConfigReconcile, mergeJsonSettings, type ConfigMeta } from "../../src/ConfigSync";

const local: ConfigMeta = { hash: "local", size: 1, mtime: 200 };
const remote: ConfigMeta = { hash: "remote", size: 1, mtime: 100 };

describe("ConfigSync reconcile decisions", () => {
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
