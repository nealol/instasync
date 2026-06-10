// Tier 3 end-to-end config.
//
// wdio-obsidian-service's worker setup is not multiremote-aware, so we run ONE
// wdio session (device A, vault A) and launch the second device (vault B)
// programmatically with `startWdioSession` inside the spec. Both are real,
// fully isolated headless Obsidian instances (separate sandboxed vault copies +
// user-data dirs => isolated IndexedDB), coordinated in one test.
//
// We boot a y-sweet server (started with --auth) AND the Realtime auth server
// (mock OIDC), sharing one key. They are pinned to the plugin's default ports
// (y-sweet 8080, auth 8081) so a freshly installed plugin reaches them with no
// URL injection; the spec signs each device in and binds it to a vault.

import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { startYSweetServer, genAuthKey, type YSweetServer } from "../support/ysweetServer.js";
import { startAuthServer, type AuthServer } from "../support/authServer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const YSWEET_PORT = Number(process.env.YSWEET_PORT ?? 8080);
const AUTH_PORT = Number(process.env.AUTH_PORT ?? 8081);

let ysweet: YSweetServer | undefined;
let authServer: AuthServer | undefined;

export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",
	specs: [path.resolve(here, "specs/**/*.e2e.ts")],
	maxInstances: 1,

	capabilities: [
		{
			browserName: "obsidian",
			browserVersion: "latest",
			"wdio:obsidianOptions": {
				installerVersion: "earliest",
				plugins: [repoRoot],
				vault: path.resolve(here, "vaults/vaultA"),
				copy: true,
			},
		} as any,
	],

	services: ["obsidian"],
	reporters: ["obsidian"],
	cacheDir: path.resolve(repoRoot, ".obsidian-cache"),
	mochaOpts: { ui: "bdd", timeout: 240_000 },
	logLevel: "warn",

	async onPrepare() {
		const authKey = await genAuthKey();
		const ysweetStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "realtime-ysweet-store-"));
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
		ysweet = await startYSweetServer(YSWEET_PORT, authKey, ysweetStoreDir);
		authServer = await startAuthServer({
			port: AUTH_PORT,
			ysweetUrl: ysweet.url,
			authKey,
			ysweetStoreDir,
			gitDataDir,
			crsqliteExtPath,
		});
	},
	async onComplete() {
		await authServer?.stop();
		await ysweet?.stop();
	},
};
