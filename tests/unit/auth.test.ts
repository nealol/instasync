import { beforeEach, describe, expect, it, vi } from "vitest";
import type RealtimePlugin from "../../src/main";

interface RequestOptions {
  url: string;
  headers?: Record<string, string>;
}

interface MockResponse {
  status: number;
  json: unknown;
  text: string;
  arrayBuffer: ArrayBuffer;
}

const http = vi.hoisted(() => ({
  handler: vi.fn<(opts: RequestOptions) => Promise<MockResponse>>(),
}));

vi.mock("obsidian", () => ({
  requestUrl: (opts: RequestOptions) => http.handler(opts),
}));

import { AuthClient, AuthError } from "../../src/auth";
import { CompatibilityError } from "../../src/caps";

const LEGACY_TOKEN_KEY = "realtime-session-token";
const KNOWN_SESSIONS_KEY = "realtime-known-sessions";
const SERVER_URL = "https://sync.example.test";
const CAPS = {
  restApi: "3",
  oauth: "1",
  pluginDbSync: "crsqlite-1",
  attachmentShim: "https://realtime.md/attachment-shim/v1",
  documentEpoch: "1",
  documentInvalidation: "1",
};

const me = (userId: string) => ({
  userId,
  email: `${userId}@example.test`,
  displayName: userId.toUpperCase(),
});

const response = (status: number, json: unknown = {}) => ({
  status,
  json,
  text: JSON.stringify(json),
  arrayBuffer: new ArrayBuffer(0),
});

function makeAuth(opts: { serverId?: string; userId?: string; token?: string } = {}) {
  const secrets = new Map<string, string>();
  const settings = {
    authServerUrl: SERVER_URL,
    authServerId: opts.serverId ?? "server-old",
    userId: opts.userId ?? "user-a",
    userDisplayName: opts.userId ? opts.userId.toUpperCase() : "",
    userEmail: opts.userId ? `${opts.userId}@example.test` : "",
    gitEmail: "",
    userPictureUrl: "",
    userAvatarUrlOverride: "",
    userAvatarUrl: "",
    activeVaultId: "vault-a",
    clientName: "Test Client",
    clientNameCustomized: false,
    pendingSetupServerUrl: "",
  };
  const plugin = {
    settings,
    app: {
      secretStorage: {
        getSecret: (key: string) => secrets.get(key) ?? null,
        setSecret: (key: string, value: string) => secrets.set(key, value),
      },
    },
    lastCompatibilityError: null,
    saveSettings: vi.fn(async () => {}),
    updateLocalAwareness: vi.fn(),
  };
  const auth = new AuthClient(plugin as unknown as RealtimePlugin);
  if (opts.token) secrets.set(tokenKey(auth), opts.token);
  return { auth, plugin, settings, secrets };
}

function serverInfo(serverId: string) {
  return response(200, { serverId, caps: CAPS, requiredCaps: [] });
}

function bearer(opts: RequestOptions): string {
  return opts.headers?.Authorization?.replace("Bearer ", "") ?? "";
}

function tokenKey(auth: AuthClient, userId?: string): string {
  const testAccess = auth as unknown as { tokenKey(userId?: string): string };
  return testAccess.tokenKey(userId);
}

beforeEach(() => {
  window.localStorage.clear();
  http.handler.mockReset();
});

describe("AuthClient session reliability", () => {
  it("recognizes and migrates a legacy token when authServerId is already set", async () => {
    const { auth, settings, secrets } = makeAuth({ serverId: "server-same", userId: "user-a" });
    secrets.set(LEGACY_TOKEN_KEY, "legacy-token");
    http.handler.mockImplementation(async (opts) => {
      if (opts.url.endsWith("/api/server-info")) return serverInfo("server-same");
      if (opts.url.endsWith("/api/me") && bearer(opts) === "legacy-token") {
        return response(200, me("user-a"));
      }
      throw new Error(`unexpected request ${opts.url}`);
    });

    expect(auth.isLoggedIn).toBe(true);
    await auth.ensureServerId();

    const currentKey = tokenKey(auth, "user-a");
    expect(settings.authServerId).toBe("server-same");
    expect(secrets.get(currentKey)).toBe("legacy-token");
    expect(secrets.get(LEGACY_TOKEN_KEY)).toBe("");
    expect(auth.isLoggedIn).toBe(true);
  });

  it("moves active and saved-account tokens when the server id changes", async () => {
    const { auth, settings, secrets } = makeAuth({
      serverId: "server-old",
      userId: "user-a",
      token: "token-a",
    });
    const oldActiveKey = tokenKey(auth, "user-a");
    const oldSavedKey = tokenKey(auth, "user-b");
    secrets.set(oldSavedKey, "token-b");
    window.localStorage.setItem(
      KNOWN_SESSIONS_KEY,
      JSON.stringify([
        { ...me("user-a"), serverUrl: SERVER_URL, serverId: "server-old", tokenKey: oldActiveKey },
        { ...me("user-b"), serverUrl: SERVER_URL, serverId: "server-old", tokenKey: oldSavedKey },
      ]),
    );
    http.handler.mockImplementation(async (opts) => {
      if (opts.url.endsWith("/api/server-info")) return serverInfo("server-new");
      if (opts.url.endsWith("/api/me")) {
        if (bearer(opts) === "token-a") return response(200, me("user-a"));
        if (bearer(opts) === "token-b") return response(200, me("user-b"));
      }
      throw new Error(`unexpected request ${opts.url}`);
    });

    await auth.ensureServerId();

    const newActiveKey = tokenKey(auth, "user-a");
    const newSavedKey = tokenKey(auth, "user-b");
    expect(settings.authServerId).toBe("server-new");
    expect(secrets.get(newActiveKey)).toBe("token-a");
    expect(secrets.get(newSavedKey)).toBe("token-b");
    expect(secrets.get(oldActiveKey)).toBe("");
    expect(secrets.get(oldSavedKey)).toBe("");
    const sessions = JSON.parse(window.localStorage.getItem(KNOWN_SESSIONS_KEY) ?? "[]");
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: "user-a",
          serverId: "server-new",
          tokenKey: newActiveKey,
        }),
        expect.objectContaining({
          userId: "user-b",
          serverId: "server-new",
          tokenKey: newSavedKey,
        }),
      ]),
    );
  });

  it("clears a rejected active token after a server id change", async () => {
    const { auth, settings, secrets } = makeAuth({
      serverId: "server-old",
      userId: "user-a",
      token: "revoked-token",
    });
    const oldKey = tokenKey(auth, "user-a");
    http.handler.mockImplementation(async (opts) => {
      if (opts.url.endsWith("/api/server-info")) return serverInfo("server-new");
      if (opts.url.endsWith("/api/me")) return response(401);
      throw new Error(`unexpected request ${opts.url}`);
    });

    await expect(auth.ensureServerId()).resolves.toBe("server-new");

    expect(settings.authServerId).toBe("server-new");
    expect(settings.userId).toBe("");
    expect(secrets.get(oldKey)).toBe("");
    expect(auth.isLoggedIn).toBe(false);
  });

  it("forgets a stale saved session without clearing another active login", async () => {
    const { auth, settings, secrets } = makeAuth({
      serverId: "server-same",
      userId: "user-a",
      token: "active-token",
    });
    const activeKey = tokenKey(auth, "user-a");
    const staleKey = tokenKey(auth, "user-b");
    secrets.set(staleKey, "stale-token");
    window.localStorage.setItem(
      KNOWN_SESSIONS_KEY,
      JSON.stringify([
        { ...me("user-a"), serverUrl: SERVER_URL, serverId: "server-same", tokenKey: activeKey },
        { ...me("user-b"), serverUrl: SERVER_URL, serverId: "server-same", tokenKey: staleKey },
      ]),
    );
    http.handler.mockImplementation(async (opts) => {
      if (opts.url.endsWith("/api/server-info")) return serverInfo("server-same");
      if (opts.url.endsWith("/api/me") && bearer(opts) === "active-token") {
        return response(200, me("user-a"));
      }
      if (opts.url.endsWith("/api/me") && bearer(opts) === "stale-token") {
        return response(401);
      }
      throw new Error(`unexpected request ${opts.url}`);
    });

    const valid = await auth.validSessionsForServer(SERVER_URL);

    expect(valid.map((session) => session.userId)).toEqual(["user-a"]);
    expect(settings.userId).toBe("user-a");
    expect(secrets.get(activeKey)).toBe("active-token");
    expect(auth.isLoggedIn).toBe(true);
    const sessions = JSON.parse(window.localStorage.getItem(KNOWN_SESSIONS_KEY) ?? "[]") as Array<{
      tokenKey: string;
    }>;
    expect(sessions.some((session) => session.tokenKey === staleKey)).toBe(false);
  });

  it("clears the current identity and throws the exact AuthError on current-token 401", async () => {
    const { auth, settings, secrets } = makeAuth({
      serverId: "server-same",
      userId: "user-a",
      token: "active-token",
    });
    const activeKey = tokenKey(auth, "user-a");
    http.handler.mockResolvedValue(response(401));

    await expect(auth.me()).rejects.toEqual(
      new AuthError("Session expired. Please sign in again."),
    );
    expect(settings.userId).toBe("");
    expect(secrets.get(activeKey)).toBe("");
  });

  it.each(["network", "server", "capability"] as const)(
    "preserves the active token on %s failures",
    async (failure) => {
      const { auth, settings, secrets } = makeAuth({
        serverId: "server-old",
        userId: "user-a",
        token: "active-token",
      });
      const activeKey = tokenKey(auth, "user-a");
      http.handler.mockImplementation(async (opts) => {
        if (opts.url.endsWith("/api/server-info")) {
          if (failure === "network") throw new Error("offline");
          if (failure === "capability") {
            return response(200, { serverId: "server-new", caps: { ...CAPS, restApi: "999" } });
          }
          return serverInfo("server-new");
        }
        if (opts.url.endsWith("/api/me")) return response(500, { error: "temporary" });
        throw new Error(`unexpected request ${opts.url}`);
      });

      if (failure === "capability") {
        await expect(auth.ensureServerId()).rejects.toBeInstanceOf(CompatibilityError);
      } else {
        await expect(auth.ensureServerId()).resolves.toBe("server-old");
      }

      expect(settings.authServerId).toBe("server-old");
      expect(settings.userId).toBe("user-a");
      expect(secrets.get(activeKey)).toBe("active-token");
      expect(auth.isLoggedIn).toBe(true);
    },
  );
});
