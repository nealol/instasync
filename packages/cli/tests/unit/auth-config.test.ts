import { describe, expect, it } from "vitest";
import { configAfterLogin } from "../../src/commands/auth";
import type { RtmdConfig } from "../../src/config";

const existing: RtmdConfig = {
  version: 1,
  baseUrl: "https://old.example.com",
  vaultId: "v1",
  auth: { mode: "user", token: "old" },
  attachmentSync: { enabled: false, includeGlobs: ["assets/**"] },
  sync: {
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
    files: {},
  },
};

describe("configAfterLogin", () => {
  it("preserves attachment policy and same-vault snapshot during re-login", () => {
    const updated = configAfterLogin(existing, {
      baseUrl: "https://new.example.com",
      vaultId: "v1",
      vaultName: "Notes",
      auth: { mode: "user", token: "new" },
    });

    expect(updated.attachmentSync).toEqual(existing.attachmentSync);
    expect(updated.sync).toBe(existing.sync);
    expect(updated.auth).toEqual({ mode: "user", token: "new" });
  });

  it("preserves folder attachment policy but drops a different vault snapshot", () => {
    const updated = configAfterLogin(existing, {
      baseUrl: "https://new.example.com",
      vaultId: "v2",
      vaultName: "Other",
      auth: { mode: "user", token: "new" },
    });

    expect(updated.attachmentSync).toEqual(existing.attachmentSync);
    expect(updated.sync).toBeUndefined();
  });
});
