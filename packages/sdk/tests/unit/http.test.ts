import { describe, expect, it, vi } from "vitest";
import {
  Http,
  encodePath,
  normalizeBaseUrl,
  staticToken,
  type TokenProvider,
} from "../../src/http";
import { ApiError, AuthError, NotFoundError } from "../../src/errors";
import { RealtimeClient } from "../../src/client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("encodePath", () => {
  it("encodes segments but keeps separators", () => {
    expect(encodePath("Notes/Hello World.md")).toBe("Notes/Hello%20World.md");
    expect(encodePath("a#b/c?d.md")).toBe("a%23b/c%3Fd.md");
    expect(encodePath("plain.md")).toBe("plain.md");
  });
});

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeBaseUrl("https://x.test/")).toBe("https://x.test");
    expect(normalizeBaseUrl("https://x.test")).toBe("https://x.test");
  });
});

describe("Http", () => {
  it("injects the bearer token and JSON headers", async () => {
    const fetch = mockFetch((url, init) => {
      expect(url).toBe("https://x.test/api/me");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      return jsonResponse(200, { ok: true });
    });
    const http = new Http({ baseUrl: "https://x.test/", auth: staticToken("tok"), fetch });
    await http.request("GET", "/api/me");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("serializes query params and skips undefined", async () => {
    const fetch = mockFetch((url) => {
      const u = new URL(url);
      expect(u.searchParams.get("q")).toBe("a b");
      expect(u.searchParams.get("limit")).toBe("5");
      expect(u.searchParams.has("before")).toBe(false);
      return jsonResponse(200, []);
    });
    const http = new Http({ baseUrl: "https://x.test", auth: staticToken("t"), fetch });
    await http.request("GET", "/api/vaults/v1/search", {
      query: { q: "a b", limit: 5, before: undefined },
    });
  });

  it("maps {error} bodies to typed errors", async () => {
    const http = new Http({
      baseUrl: "https://x.test",
      auth: staticToken("t"),
      fetch: mockFetch(() => jsonResponse(404, { error: "not found" })),
    });
    await expect(http.request("GET", "/api/x")).rejects.toThrow(NotFoundError);
  });

  it("falls back to HTTP status for empty bodies (blob routes)", async () => {
    const http = new Http({
      baseUrl: "https://x.test",
      auth: staticToken("t"),
      fetch: mockFetch(() => new Response(null, { status: 409 })),
    });
    await expect(http.request("GET", "/api/x")).rejects.toMatchObject({
      status: 409,
      message: "HTTP 409",
      constructor: ApiError,
    });
  });

  it("retries once via onUnauthorized and succeeds", async () => {
    let calls = 0;
    const tokens: TokenProvider = {
      getToken: () => (calls === 0 ? "stale" : "fresh"),
      onUnauthorized: async () => {
        calls++;
        return "fresh";
      },
    };
    const fetch = mockFetch((_url, init) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === "Bearer fresh"
        ? jsonResponse(200, { ok: true })
        : jsonResponse(401, { error: "unauthorized" });
    });
    const http = new Http({ baseUrl: "https://x.test", auth: tokens, fetch });
    await expect(http.request<{ ok: boolean }>("GET", "/api/me")).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws AuthError when the retry also 401s", async () => {
    const tokens: TokenProvider = {
      getToken: () => "bad",
      onUnauthorized: async () => "still-bad",
    };
    const fetch = mockFetch(() => jsonResponse(401, { error: "unauthorized" }));
    const http = new Http({ baseUrl: "https://x.test", auth: tokens, fetch });
    await expect(http.request("GET", "/api/me")).rejects.toThrow(AuthError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("RealtimeClient URL construction", () => {
  function capture() {
    const requests: { url: string; method: string; body?: string }[] = [];
    const fetch = mockFetch((url, init) => {
      requests.push({ url, method: init.method ?? "GET", body: init.body as string | undefined });
      return jsonResponse(200, {});
    });
    return {
      requests,
      client: new RealtimeClient({ baseUrl: "https://x.test", token: "t", fetch }),
    };
  }

  it("builds note routes with encoded wildcard paths", async () => {
    const { requests, client } = capture();
    const vault = client.vault("v1");
    await vault.notes.read("Folder/My Note.md");
    await vault.notes.move("a.md", "b/c.md");
    await vault.frontmatter.patch("n.md", { set: { k: 1 } });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET https://x.test/api/vaults/v1/notes/Folder/My%20Note.md",
      "POST https://x.test/api/vaults/v1/note-moves/a.md",
      "PATCH https://x.test/api/vaults/v1/note-frontmatter/n.md",
    ]);
    expect(JSON.parse(requests[1].body!)).toEqual({ toPath: "b/c.md" });
    expect(JSON.parse(requests[2].body!)).toEqual({ set: { k: 1 }, unset: [] });
  });

  it("builds vault, cursor, and audit routes", async () => {
    const { requests, client } = capture();
    await client.vaults.create("My Vault");
    const vault = client.vault("v1");
    await vault.cursors.acquirePlugin("my-plugin");
    await vault.cursors.audit("c9").list({ before: 123, limit: 10 });
    await vault.cursors.audit("c9").undo("e1", { force: true });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST https://x.test/api/vaults",
      "POST https://x.test/api/vaults/v1/cursors/plugin",
      "GET https://x.test/api/vaults/v1/cursors/c9/audit?before=123&limit=10",
      "POST https://x.test/api/vaults/v1/cursors/c9/audit/e1/undo",
    ]);
    expect(JSON.parse(requests[3].body!)).toEqual({ force: true });
  });

  it("builds plugin-db replication routes", async () => {
    const { requests, client } = capture();
    const fetchMock = client.http as unknown as { request: unknown };
    void fetchMock;
    const db = client.vault("v1").pluginDb("my-plugin", "main");
    await db.changes({ abc: 7 }).catch(() => {}); // response shape {changes} missing in mock
    await db.touch();
    expect(requests[0].url).toBe(
      "https://x.test/api/vaults/v1/plugin-dbs/my-plugin/main/changes?since=%7B%22abc%22%3A7%7D",
    );
    expect(requests[1].url).toBe("https://x.test/api/vaults/v1/plugin-dbs/my-plugin/main/touch");
  });

  it("builds plugin-db SQL (query/execute/list) routes", async () => {
    const { requests, client } = capture();
    const vault = client.vault("v1");
    const db = vault.pluginDb("my-plugin", "main");
    await db.query("SELECT title FROM tasks", { params: ["x"], limit: 10 }).catch(() => {});
    await db.execute([{ sql: "INSERT INTO tasks VALUES (?1)", params: [1] }]).catch(() => {});
    await vault.listPluginDbs().catch(() => {});
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST https://x.test/api/vaults/v1/plugin-dbs/my-plugin/main/query",
      "POST https://x.test/api/vaults/v1/plugin-dbs/my-plugin/main/execute",
      "GET https://x.test/api/vaults/v1/plugin-dbs",
    ]);
    expect(JSON.parse(requests[0].body!)).toEqual({
      sql: "SELECT title FROM tasks",
      params: ["x"],
      limit: 10,
    });
    expect(JSON.parse(requests[1].body!)).toEqual({
      statements: [{ sql: "INSERT INTO tasks VALUES (?1)", params: [1] }],
    });
  });
});
