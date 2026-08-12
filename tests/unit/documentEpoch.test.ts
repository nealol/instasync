import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  epochPersistenceName,
  getDocumentEpoch,
  resetDocumentEpochStateForTests,
  setDocumentEpoch,
} from "../../src/documentEpoch";
import {
  DocumentEpochChangedError,
  DocumentEpochPendingError,
  getClientToken,
  resetTokenRetryStateForTests,
} from "../../src/sync/clientToken";

function plugin(server = "server-a") {
  return {
    settings: {
      authServerId: server,
      authServerUrl: "https://sync.example.com",
      activeVaultId: "vault",
    },
    auth: { docToken: vi.fn() },
    acceptDocumentEpoch: vi.fn(),
  } as any;
}

beforeEach(() => {
  localStorage.clear();
  resetDocumentEpochStateForTests();
  resetTokenRetryStateForTests(0);
});

describe("document epochs", () => {
  it("scopes durable epochs and IndexedDB names by server and document", () => {
    const first = plugin("server-a");
    const second = plugin("server-b");
    expect(getDocumentEpoch(first, "vault__note")).toBe(0);
    expect(setDocumentEpoch(first, "vault__note", 4)).toBe(true);
    expect(setDocumentEpoch(first, "vault__note", 4)).toBe(false);
    expect(getDocumentEpoch(first, "vault__note")).toBe(4);
    expect(getDocumentEpoch(first, "vault__other")).toBe(0);
    expect(getDocumentEpoch(second, "vault__note")).toBe(0);
    expect(epochPersistenceName(first, "vault__note", "persisted")).toBe("persisted:epoch:4");
  });

  it("keeps the released persistence namespace for epoch zero", () => {
    expect(epochPersistenceName(plugin(), "vault__note", "persisted")).toBe("persisted");
  });

  it("rejects invalid epoch values before they can be acknowledged", () => {
    const instance = plugin();
    expect(() => setDocumentEpoch(instance, "vault__note", -1)).toThrow("invalid document epoch");
    expect(() => setDocumentEpoch(instance, "vault__note", 1.5)).toThrow("invalid document epoch");
    setDocumentEpoch(instance, "vault__note", 2);
    expect(() => setDocumentEpoch(instance, "vault__note", 1)).toThrow("cannot move backward");
  });

  it("refuses a token for a newer epoch and asks the plugin to rebuild first", async () => {
    const instance = plugin();
    instance.auth.docToken.mockResolvedValue({
      url: "wss://sync.example.com/d/vault__note/ws",
      baseUrl: "https://sync.example.com/d/vault__note",
      docId: "vault__note",
      token: "token",
      epoch: 3,
    });

    await expect(getClientToken(instance, "vault__note")).rejects.toEqual(
      expect.objectContaining<DocumentEpochChangedError>({
        name: "DocumentEpochChangedError",
        documentId: "vault__note",
        epoch: 3,
      }),
    );
    expect(instance.acceptDocumentEpoch).toHaveBeenCalledWith("vault__note", 3);
  });

  it("returns a token when its epoch matches durable local state", async () => {
    const instance = plugin();
    setDocumentEpoch(instance, "vault__note", 2);
    const token = {
      url: "wss://sync.example.com/d/vault__note/ws",
      baseUrl: "https://sync.example.com/d/vault__note",
      docId: "vault__note",
      token: "token",
      epoch: 2,
    };
    instance.auth.docToken.mockResolvedValue(token);
    await expect(getClientToken(instance, "vault__note")).resolves.toEqual(token);
    expect(instance.acceptDocumentEpoch).not.toHaveBeenCalled();
  });

  it("uses a read-only retiring-epoch token to finish an interrupted acknowledgement", async () => {
    const instance = plugin();
    setDocumentEpoch(instance, "vault__note", 3);
    instance.auth.docToken
      .mockResolvedValueOnce({
        url: "wss://sync.example.com/d/vault__note/ws",
        baseUrl: "https://sync.example.com/d/vault__note",
        docId: "vault__note",
        token: "old-epoch-token",
        epoch: 2,
      })
      .mockResolvedValueOnce({
        url: "wss://sync.example.com/d/vault__note/ws",
        baseUrl: "https://sync.example.com/d/vault__note",
        docId: "vault__note",
        token: "read-only-old-epoch-token",
        authorization: "read-only",
        epoch: 2,
      });

    await expect(getClientToken(instance, "vault__note")).resolves.toEqual(
      expect.objectContaining({
        token: "read-only-old-epoch-token",
        authorization: "read-only",
        epoch: 2,
      }),
    );
    expect(instance.auth.docToken).toHaveBeenNthCalledWith(
      2,
      "vault",
      "vault__note",
      undefined,
      "read-only",
    );
    expect(getDocumentEpoch(instance, "vault__note")).toBe(3);
    expect(instance.acceptDocumentEpoch).not.toHaveBeenCalled();
  });

  it("rejects a recovery token unless the server confirms read-only authorization", async () => {
    const instance = plugin();
    setDocumentEpoch(instance, "vault__note", 3);
    instance.auth.docToken
      .mockResolvedValueOnce({
        url: "wss://sync.example.com/d/vault__note/ws",
        baseUrl: "https://sync.example.com/d/vault__note",
        docId: "vault__note",
        token: "old-epoch-token",
        epoch: 2,
      })
      .mockResolvedValueOnce({
        url: "wss://sync.example.com/d/vault__note/ws",
        baseUrl: "https://sync.example.com/d/vault__note",
        docId: "vault__note",
        token: "unsafe-full-old-epoch-token",
        authorization: "full",
        epoch: 2,
      });

    await expect(getClientToken(instance, "vault__note")).rejects.toEqual(
      expect.objectContaining<DocumentEpochPendingError>({
        name: "DocumentEpochPendingError",
        documentId: "vault__note",
        localEpoch: 3,
        serverEpoch: 2,
      }),
    );
  });

  it("does not globally back off unrelated documents while an epoch is pending", async () => {
    resetTokenRetryStateForTests(30_000);
    const instance = plugin();
    setDocumentEpoch(instance, "vault__pending", 3);
    instance.auth.docToken.mockImplementation(
      async (
        _vault: string,
        docId: string,
        _path?: string,
        authorization?: "full" | "read-only",
      ) => ({
        url: `wss://sync.example.com/d/${docId}/ws`,
        baseUrl: `https://sync.example.com/d/${docId}`,
        docId,
        token: "token",
        authorization,
        epoch: docId === "vault__pending" ? 2 : 0,
      }),
    );

    await expect(getClientToken(instance, "vault__pending")).resolves.toEqual(
      expect.objectContaining({ docId: "vault__pending", authorization: "read-only" }),
    );
    await expect(getClientToken(instance, "vault__other")).resolves.toEqual(
      expect.objectContaining({ docId: "vault__other" }),
    );
  });
});
