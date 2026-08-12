// Tier 3 end-to-end config.
//
// wdio-obsidian-service's worker setup is not multiremote-aware, so we run ONE
// wdio session (device A, vault A) and launch the second device (vault B)
// programmatically with `startWdioSession` inside the spec. Both are real,
// fully isolated headless Obsidian instances (separate sandboxed vault copies +
// user-data dirs => isolated IndexedDB), coordinated in one test.
//
// We boot the Realtime server in mock-OIDC mode on the plugin's default port,
// so a freshly installed plugin reaches it with no URL injection.

import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { startAuthServer, type AuthServer } from "../support/authServer.js";
import {
  restoreObsidianProtocolRegistry,
  snapshotObsidianProtocolRegistry,
  type ProtocolRegistrySnapshot,
} from "./protocolRegistry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const AUTH_PORT = Number(process.env.AUTH_PORT ?? 8081);

let authServer: AuthServer | undefined;
let obsidianProtocolSnapshot: ProtocolRegistrySnapshot | undefined;
let obsidianProtocolRestored = false;

function restoreObsidianProtocolOnce() {
  if (obsidianProtocolRestored) return;
  restoreObsidianProtocolRegistry(obsidianProtocolSnapshot);
  obsidianProtocolRestored = true;
}

function restoreObsidianProtocolOnExit() {
  try {
    restoreObsidianProtocolOnce();
  } catch (error) {
    console.warn("Failed to restore Obsidian protocol registry handler", error);
  }
}

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",
  specs: [path.resolve(here, "specs/**/*.e2e.ts")],
  maxInstances: 1,

  capabilities: [
    {
      browserName: "obsidian",
      browserVersion: process.env.OBSIDIAN_E2E_VERSION ?? "latest",
      "wdio:obsidianOptions": {
        installerVersion: "earliest",
        plugins: [repoRoot],
        vault: path.resolve(here, "vaults/vaultA"),
        copy: true,
      },
      "goog:chromeOptions": {
        args: [
          "--headless=new",
          "--disable-gpu",
          "--window-size=1440,1000",
          "--window-position=-32000,-32000",
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
          "--disable-backgrounding-occluded-windows",
        ],
      },
    } as any,
  ],

  services: ["obsidian"],
  reporters: ["obsidian"],
  cacheDir: path.resolve(repoRoot, ".obsidian-cache"),
  mochaOpts: { ui: "bdd", timeout: 240_000 },
  logLevel: "warn",

  async before(_capabilities, _specs, browser) {
    await browser.execute(() => window.electron?.remote?.getCurrentWindow?.().hide?.());
  },

  async onPrepare() {
    obsidianProtocolSnapshot = snapshotObsidianProtocolRegistry();
    process.once("exit", restoreObsidianProtocolOnExit);
    const crdtStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "realtime-crdt-store-"));
    // Git audit commits go to a temp dir the spec can inspect (plugin-db git
    // dump assertions). The cr-sqlite loadable extension is passed through
    // from the environment when available (enables server replicas + dumps);
    // the corresponding spec assertions skip when it is not set.
    const gitDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "realtime-git-"));
    process.env.E2E_GIT_DATA_DIR = gitDataDir;
    const crsqliteExtPath =
      process.env.CRSQLITE_EXT_PATH && fs.existsSync(process.env.CRSQLITE_EXT_PATH)
        ? process.env.CRSQLITE_EXT_PATH
        : undefined;
    authServer = await startAuthServer({
      port: AUTH_PORT,
      crdtStoreDir,
      gitDataDir,
      crsqliteExtPath,
    });
  },
  async onComplete() {
    try {
      await authServer?.stop();
    } finally {
      restoreObsidianProtocolOnce();
    }
  },
};
