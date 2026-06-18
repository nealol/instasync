import { describe, expect, it } from "vitest";
import { ensureParentFolder } from "../../src/vaultHelpers";
import { FakeVault } from "../support/fakePlugin";

describe("vault helpers", () => {
  it("creates nested parent folders segment by segment", async () => {
    const vault = new FakeVault();
    await ensureParentFolder({ vault } as any, "a/b/c/file.md");

    expect(vault.folders.has("a")).toBe(true);
    expect(vault.folders.has("a/b")).toBe(true);
    expect(vault.folders.has("a/b/c")).toBe(true);
  });
});
