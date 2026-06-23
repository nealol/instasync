import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RealtimeClient, AuthError } from "../../src/index";
import { loginViaBrowser } from "../../src/node";
import { startAuthHarness, fetchBrowser, freePort, type AuthHarness } from "../support/harness";

let harness: AuthHarness;
let loopbackPort: number;

beforeAll(async () => {
  loopbackPort = await freePort();
  harness = await startAuthHarness({
    allowedLoginRedirects: [`http://127.0.0.1:${loopbackPort}`],
  });
});

afterAll(async () => {
  await harness?.stop();
});

function clientFor(token: string): RealtimeClient {
  return new RealtimeClient({ baseUrl: harness.authUrl, token });
}

describe("auth", () => {
  it("authenticates with a session token and returns the identity", async () => {
    const token = await harness.loginUser("alice");
    const client = clientFor(token);
    const me = await client.me();
    expect(me.userId).toBeTruthy();
    expect(me.displayName).toBe("alice");
    const info = await client.serverInfo();
    expect(info.serverId).toBeTruthy();
  });

  it("rejects a bad token with AuthError", async () => {
    await expect(clientFor("not-a-token").me()).rejects.toThrow(AuthError);
  });

  it("logout invalidates the session", async () => {
    const token = await harness.loginUser("bob");
    const client = clientFor(token);
    await client.me();
    await client.logout();
    await expect(client.me()).rejects.toThrow(AuthError);
  });

  it("logs in interactively via the loopback redirect", async () => {
    const token = await loginViaBrowser({
      baseUrl: harness.authUrl,
      port: loopbackPort,
      openBrowser: fetchBrowser("carol"),
    });
    const me = await clientFor(token).me();
    expect(me.displayName).toBe("carol");
  });

  it("returns avatar fields from me() and updateMe()", async () => {
    const token = await harness.loginUser("dave");
    const client = clientFor(token);
    const me = await client.me();
    expect(me).toHaveProperty("pictureUrl");
    expect(me).toHaveProperty("avatarUrlOverride");
    expect(me).toHaveProperty("avatarUrl");

    const updated = await client.updateMe({
      avatarUrlOverride: "https://cdn.example.com/sdk.png",
    });
    expect(updated.avatarUrlOverride).toBe("https://cdn.example.com/sdk.png");
    expect(updated.avatarUrl).toBe("https://cdn.example.com/sdk.png");

    // Clear the override.
    const cleared = await client.updateMe({ avatarUrlOverride: null });
    expect(cleared.avatarUrlOverride).toBeNull();
  });
});

describe("vaults, invites, members", () => {
  it("creates and lists vaults", async () => {
    const client = clientFor(await harness.loginUser("alice"));
    const vault = await client.vaults.create("SDK Vault");
    expect(vault.id).toBeTruthy();
    expect(vault.name).toBe("SDK Vault");
    expect(vault.role).toBe("admin");
    const all = await client.vaults.list();
    expect(all.map((v) => v.id)).toContain(vault.id);
  });

  it("runs the invite → redeem → promote → remove membership cycle", async () => {
    const admin = clientFor(await harness.loginUser("alice"));
    const member = clientFor(await harness.loginUser("dave"));
    const vault = await admin.vaults.create("Shared Vault");

    const invite = await admin.invites.create(vault.id);
    const redeemed = await member.invites.redeem(invite.code);
    expect(redeemed.vaultId).toBe(vault.id);
    expect(redeemed.name).toBe("Shared Vault");

    const daveId = (await member.me()).userId;
    const adminVault = admin.vault(vault.id);
    let members = await adminVault.members.list();
    expect(members.find((m) => m.userId === daveId)?.role).toBe("member");

    const promoted = await adminVault.members.promote(daveId);
    expect(promoted.role).toBe("admin");

    await adminVault.members.remove(daveId);
    members = await adminVault.members.list();
    expect(members.find((m) => m.userId === daveId)).toBeUndefined();
  });
});
