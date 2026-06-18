import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startAuthHarness, type AuthHarness } from "../support/authServer";
import { makeFakePlugin, type FakePlugin } from "../support/fakePlugin";
import { Peer } from "../support/peer";
import { waitFor, freshGuid } from "../support/util";

describe("harness smoke", () => {
  let harness: AuthHarness;
  let plugin: FakePlugin;
  let vaultId: string;

  beforeAll(async () => {
    harness = await startAuthHarness();
    const token = await harness.loginUser("smoke");
    const vault = await harness.createVault(token, "smoke");
    vaultId = vault.id;
    plugin = makeFakePlugin(harness.authUrl, {
      sessionToken: token,
      activeVaultId: vaultId,
    }).plugin;
  }, 180_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it("two peers sync text through the auth server + y-sweet", async () => {
    const docId = `${vaultId}__${freshGuid()}`;
    const a = new Peer(plugin, docId);
    const b = new Peer(plugin, docId);
    try {
      await a.whenSynced();
      await b.whenSynced();

      a.setText("hello from A");
      await waitFor(() => b.getText() === "hello from A", { label: "B sees A" });

      b.setText("hello from A and B");
      await waitFor(() => a.getText() === "hello from A and B", { label: "A sees B" });

      expect(a.getText()).toBe("hello from A and B");
    } finally {
      a.destroy();
      b.destroy();
    }
  });
});
