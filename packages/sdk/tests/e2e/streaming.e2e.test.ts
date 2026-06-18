import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CursorClient, RealtimeClient, type VaultHandle } from "../../src/index";
import { startAuthHarness, type AuthHarness } from "../support/harness";

let harness: AuthHarness;
let admin: RealtimeClient;
let vaultId: string;
let vault: VaultHandle;
let cursor: CursorClient;

beforeAll(async () => {
  harness = await startAuthHarness();
  admin = new RealtimeClient({ baseUrl: harness.authUrl, token: await harness.loginUser("alice") });
  vaultId = (await admin.vaults.create("Stream Vault")).id;
  vault = admin.vault(vaultId);

  // Stream with a plugin-managed cursor grant, like the Obsidian plugin does.
  const grant = await vault.cursors.acquirePlugin("sdk-e2e", "Streamer");
  expect(grant.streamUrl).toContain(`/api/vaults/${vaultId}/stream`);
  cursor = new CursorClient({ baseUrl: harness.authUrl, vaultId, token: grant.secretToken });
});

afterAll(async () => {
  await harness?.stop();
});

describe("streaming WebSocket API", () => {
  it("appends streamed chunks to the end of a note", async () => {
    await vault.notes.create("Stream/Append.md", "intro\n");

    const stream = await cursor.stream("Stream/Append.md");
    expect(stream.guid).toBeTruthy();
    await stream.write("one ");
    await stream.write("two ");
    await stream.write("three");
    const result = await stream.end();

    expect(result.inserted).toBe("one two three".length);
    expect(result.auditId).toBeTruthy();
    expect((await vault.notes.read("Stream/Append.md")).content).toBe("intro\none two three");
  });

  it("anchors after a marker", async () => {
    await vault.notes.create("Stream/After.md", "# Title\n\n## Draft\n\n## Done\n");
    const result = await cursor.streamText("Stream/After.md", ["inserted-here"], {
      mode: "after",
      text: "## Draft",
    });
    expect(result.inserted).toBeGreaterThan(0);
    const content = (await vault.notes.read("Stream/After.md")).content;
    expect(content.indexOf("inserted-here")).toBeGreaterThan(content.indexOf("## Draft"));
    expect(content.indexOf("inserted-here")).toBeLessThan(content.indexOf("## Done"));
  });

  it("anchors at a byte offset", async () => {
    await vault.notes.create("Stream/Offset.md", "abcdef");
    await cursor.streamText("Stream/Offset.md", ["XYZ"], { mode: "offset", offset: 3 });
    expect((await vault.notes.read("Stream/Offset.md")).content).toBe("abcXYZdef");
  });

  it("records the whole session as one audit entry", async () => {
    await vault.notes.create("Stream/Audited.md", "");
    const result = await cursor.streamText("Stream/Audited.md", ["audited ", "stream"]);

    const cursors = await vault.cursors.list();
    const me = cursors.find((c) => c.pluginId === "sdk-e2e");
    const page = await vault.cursors.audit(me!.id).list();
    expect(page.entries.some((e) => e.id === result.auditId)).toBe(true);
  });

  it("rejects a stream into a missing note", async () => {
    await expect(cursor.stream("Stream/DoesNotExist.md")).rejects.toThrow();
  });
});
