import { describe, expect, it, vi } from "vitest";
import { RealtimeSharesAPI } from "../../src/shares/api";
import type RealtimePlugin from "../../src/main";

function makePlugin(overrides?: {
  enabled?: boolean;
  loggedIn?: boolean;
  vaultId?: string | null;
}) {
  const createPublicShare = vi.fn(async (_vaultId: string, path: string) => ({
    id: "note-share-id",
    url: `https://realtime.example/view/${encodeURIComponent(path)}`,
    guid: "note-guid",
    path,
    createdAt: 1,
  }));
  const createPublicAttachmentShare = vi.fn(async (_vaultId: string, path: string) => ({
    id: "attachment-share-id",
    url: `https://realtime.example/a/${encodeURIComponent(path)}`,
    path,
    hash: "hash",
    size: 42,
    createdAt: 1,
  }));
  const plugin = {
    settings: {
      enabled: overrides?.enabled ?? true,
      activeVaultId: overrides?.vaultId === undefined ? "vault-id" : overrides.vaultId,
    },
    auth: {
      isLoggedIn: overrides?.loggedIn ?? true,
      createPublicShare,
      createPublicAttachmentShare,
    },
  } as unknown as RealtimePlugin;
  return {
    api: new RealtimeSharesAPI(plugin),
    createPublicShare,
    createPublicAttachmentShare,
  };
}

describe("shares plugin API", () => {
  it("returns a public note URL", async () => {
    const { api, createPublicShare } = makePlugin();

    await expect(api.getNoteUrl("Reports/July.md")).resolves.toBe(
      "https://realtime.example/view/Reports%2FJuly.md",
    );
    expect(createPublicShare).toHaveBeenCalledWith("vault-id", "Reports/July.md");
  });

  it("returns a version-scoped public attachment URL", async () => {
    const { api, createPublicAttachmentShare } = makePlugin();

    await expect(api.getAttachmentUrl("media/image 1.png")).resolves.toBe(
      "https://realtime.example/a/media%2Fimage%201.png",
    );
    expect(createPublicAttachmentShare).toHaveBeenCalledWith("vault-id", "media/image 1.png");
  });

  it("requires an enabled, signed-in vault before sharing", async () => {
    await expect(makePlugin({ enabled: false }).api.getNoteUrl("note.md")).rejects.toThrow(
      "Realtime is disabled",
    );
    await expect(makePlugin({ loggedIn: false }).api.getAttachmentUrl("image.png")).rejects.toThrow(
      "Realtime is signed out",
    );
    await expect(makePlugin({ vaultId: null }).api.getNoteUrl("note.md")).rejects.toThrow(
      "Realtime has no active vault",
    );
  });
});
