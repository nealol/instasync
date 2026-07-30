import { browser, expect } from "@wdio/globals";
import { startWdioSession } from "wdio-obsidian-service";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  signInDevice,
  createVaultFromLocal,
  generateInvite,
  redeemAndAdopt,
  writeNote,
  enableConfigSync,
  writeConfigFile,
  readConfigFile,
  configFileExists,
  removeConfigFile,
  triggerConfigReconcile,
  configMapHas,
} from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const vaultB = path.resolve(here, "../vaults/vaultB");
const cacheDir = path.resolve(repoRoot, ".obsidian-cache");

const SECONDS = 1000;
const AUTH_PORT = Number(process.env.AUTH_PORT ?? 8081);
const authUrl = `http://127.0.0.1:${AUTH_PORT}`;
const OBSIDIAN_E2E_VERSION = process.env.OBSIDIAN_E2E_VERSION ?? "latest";

// Config sync mirrors Obsidian Sync's selective settings sync. These tests
// drive the real two-instance flow: device A is the wdio session (vault A) and
// device B is a second, fully isolated Obsidian started programmatically (vault
// B). Both enable config sync but with ONLY the categories under test on
// (`hotkeys`, `themesAndSnippets`), so each instance's own generated
// app.json/appearance.json/workspace files can't fight each other and
// destabilize the assertions.
let A: WebdriverIO.Browser;
let B: WebdriverIO.Browser;
let vaultId: string;
let adminToken: string;

const ENABLED_CATEGORIES = ["hotkeys", "themesAndSnippets"];

/** The plugin's live connection status, read from its API (not the DOM). */
async function pluginStatus(dev: any): Promise<string> {
  return dev.executeObsidian(
    async ({ app }: any) => (app as any).plugins.plugins.realtime?.status ?? "",
  );
}

/** Wait until a device's plugin reports a live ("connected") sync connection. */
async function waitLive(dev: any, label: string): Promise<void> {
  let last = "";
  await dev.waitUntil(
    async () => {
      last = await pluginStatus(dev);
      return last === "connected";
    },
    {
      timeout: 90 * SECONDS,
      timeoutMsg: `${label} never reached 'connected' (last status: ${last})`,
    },
  );
}

/**
 * Bounded negative check: repeatedly trigger reconciles on both devices for a
 * window, asserting the config-relative path never appears on `dev`. Used to
 * prove gating / non-syncing paths don't propagate (positive propagation
 * normally lands in ~1-2s via the Y.Map observer, so a ~4s window with active
 * triggers is a safe bound).
 */
async function assertNeverAppears(dev: any, rel: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await triggerConfigReconcile(A);
    await triggerConfigReconcile(B);
    await dev.pause(500);
    expect(await configFileExists(dev, rel)).toBe(false);
  }
}

describe("Realtime — config-folder sync across two devices", function () {
  before(async function () {
    A = browser;
    B = await startWdioSession({
      capabilities: {
        browserName: "obsidian",
        browserVersion: OBSIDIAN_E2E_VERSION,
        "wdio:obsidianOptions": {
          installerVersion: "earliest",
          plugins: [repoRoot],
          vault: vaultB,
          copy: true,
        },
      },
      cacheDir,
    } as any);

    // Device A: sign in, seed a file, create a vault from the local files.
    adminToken = await signInDevice(A, authUrl, "alice");
    await writeNote(A, "Seed.md", "seeded on A");
    vaultId = await createVaultFromLocal(A, "config-shared");

    // Device B: sign in as a different user, then redeem an invite and adopt.
    await signInDevice(B, authUrl, "bob");
    const code = await generateInvite(authUrl, adminToken, vaultId);
    await redeemAndAdopt(B, code);

    await waitLive(A, "A");
    await waitLive(B, "B");

    // Enable config sync with only the categories under test, then wait until
    // both devices reconnect (reloadSync drops the socket briefly).
    await enableConfigSync(A, ENABLED_CATEGORIES);
    await enableConfigSync(B, ENABLED_CATEGORIES);
    await waitLive(A, "A");
    await waitLive(B, "B");
  });

  after(async function () {
    await B?.deleteSession();
  });

  it("propagates a new hotkeys.json A -> B", async function () {
    const content = JSON.stringify({ "editor:fold": [{ modifiers: ["Mod"], key: "1" }] }, null, 2);
    await writeConfigFile(A, "hotkeys.json", content);
    await triggerConfigReconcile(A); // local dotfile writes aren't auto-noticed

    await B.waitUntil(async () => (await readConfigFile(B, "hotkeys.json")) === content, {
      timeout: 60 * SECONDS,
      timeoutMsg: `B never received hotkeys.json (got: ${await readConfigFile(B, "hotkeys.json")})`,
    });
  });

  it("propagates an edit of hotkeys.json B -> A", async function () {
    const content = JSON.stringify(
      { "editor:fold": [{ modifiers: ["Mod", "Shift"], key: "2" }] },
      null,
      2,
    );
    await writeConfigFile(B, "hotkeys.json", content);
    await triggerConfigReconcile(B);

    await A.waitUntil(async () => (await readConfigFile(A, "hotkeys.json")) === content, {
      timeout: 60 * SECONDS,
      timeoutMsg: `A never converged to B's hotkeys.json (got: ${await readConfigFile(A, "hotkeys.json")})`,
    });
  });

  it("propagates a delete of hotkeys.json A -> B", async function () {
    // The file has fully round-tripped (tests 1 & 2), so A's baseline equals the
    // remote hash and the delete is published rather than treated as a stale
    // never-pulled file. The delete must NOT happen during the initial pull.
    expect(await configFileExists(A, "hotkeys.json")).toBe(true);
    await removeConfigFile(A, "hotkeys.json");
    await triggerConfigReconcile(A);

    await B.waitUntil(async () => (await configFileExists(B, "hotkeys.json")) === false, {
      timeout: 60 * SECONDS,
      timeoutMsg: "B still has hotkeys.json after A deleted it",
    });
    // And it's gone from the shared map, not just B's disk.
    expect(await configMapHas(A, "hotkeys.json")).toBe(false);
  });

  it("does not sync a disabled category (installed community plugins)", async function () {
    // installedCommunityPlugins is off (only hotkeys + themesAndSnippets on).
    const rel = "plugins/fakeplug/data.json";
    await writeConfigFile(A, rel, JSON.stringify({ setting: "value" }));
    await triggerConfigReconcile(A);

    await assertNeverAppears(B, rel);
    // The gated file never entered the shared map either.
    expect(await configMapHas(A, rel)).toBe(false);
  });

  it("syncs a nested snippet file, creating the parent folder on B", async function () {
    const css = "/* e2e snippet */\nbody { --e2e: 1; }\n";
    await writeConfigFile(A, "snippets/test.css", css);
    await triggerConfigReconcile(A);

    await B.waitUntil(async () => (await readConfigFile(B, "snippets/test.css")) === css, {
      timeout: 60 * SECONDS,
      timeoutMsg: `B never received the nested snippet (got: ${await readConfigFile(B, "snippets/test.css")})`,
    });
  });

  it("does not sync an unclassifiable file", async function () {
    // A top-level non-JSON file has no category, so it must never propagate.
    const rel = "some.log";
    await writeConfigFile(A, rel, "log line\n");
    await triggerConfigReconcile(A);

    await assertNeverAppears(B, rel);
    expect(await configMapHas(A, rel)).toBe(false);
  });

  it("merges a JSON conflict, keeping keys from both sides", async function () {
    // Establish a shared baseline for a fresh JSON file.
    const base = JSON.stringify({ shared: 0 }, null, 2);
    await writeConfigFile(A, "hotkeys.json", base);
    await triggerConfigReconcile(A);
    await B.waitUntil(async () => (await readConfigFile(B, "hotkeys.json")) === base, {
      timeout: 60 * SECONDS,
      timeoutMsg: "baseline hotkeys.json never reached B",
    });
    // Let B's reconcile settle its baseline for the file before diverging.
    await B.pause(SECONDS);

    // Diverge on BOTH sides before either reconciles. Dotfolder writes aren't
    // auto-noticed, so neither edit publishes until triggered — giving a true
    // three-way conflict (both changed vs the shared baseline).
    await writeConfigFile(A, "hotkeys.json", JSON.stringify({ shared: 0, fromA: "a" }, null, 2));
    await writeConfigFile(B, "hotkeys.json", JSON.stringify({ shared: 0, fromB: "b" }, null, 2));

    // Publish ONLY B's edit (upload to the shared map). A never uploads, so A
    // keeps the original baseline; A's Y.Map observer then fires with local !=
    // remote != baseline on a .json file and shallow-merges (local keys on top
    // of remote). Driving the merge from the non-publishing side avoids the
    // publish/propagation race that a two-sided trigger would introduce.
    await triggerConfigReconcile(B);

    // Both devices must converge on a document containing both sides' keys.
    const hasBothKeys = (text: string | null): boolean => {
      if (!text) return false;
      try {
        const o = JSON.parse(text);
        return o && o.fromA === "a" && o.fromB === "b";
      } catch {
        return false;
      }
    };
    await A.waitUntil(async () => hasBothKeys(await readConfigFile(A, "hotkeys.json")), {
      timeout: 60 * SECONDS,
      timeoutMsg: `A never showed the merged doc (got: ${await readConfigFile(A, "hotkeys.json")})`,
    });
    await B.waitUntil(async () => hasBothKeys(await readConfigFile(B, "hotkeys.json")), {
      timeout: 60 * SECONDS,
      timeoutMsg: `B never showed the merged doc (got: ${await readConfigFile(B, "hotkeys.json")})`,
    });
    expect(await readConfigFile(A, "hotkeys.json")).toBe(await readConfigFile(B, "hotkeys.json"));
  });
});
