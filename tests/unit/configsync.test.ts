import { describe, expect, it } from "vitest";
import { decideConfigReconcile, type ConfigMeta } from "../../src/ConfigSync";

const local: ConfigMeta = { hash: "local", size: 1, mtime: 200 };
const remote: ConfigMeta = { hash: "remote", size: 1, mtime: 100 };

describe("ConfigSync reconcile decisions", () => {
  it("downloads remote config on a fresh device when both sides exist", () => {
    expect(decideConfigReconcile(local, remote, null)).toBe("download");
  });

  it("downloads remote config instead of publishing a delete when local is missing", () => {
    expect(decideConfigReconcile(null, remote, remote.hash)).toBe("download");
  });

  it("keeps existing post-baseline conflict behavior for devices with a baseline", () => {
    expect(decideConfigReconcile(local, remote, remote.hash)).toBe("upload");
    expect(decideConfigReconcile(local, remote, local.hash)).toBe("download");
  });
});
