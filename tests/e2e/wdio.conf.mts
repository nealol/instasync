// Tier 3 end-to-end config.
//
// wdio-obsidian-service's worker setup is not multiremote-aware, so we run ONE
// wdio session (device A, vault A) and launch the second device (vault B)
// programmatically with `startWdioSession` inside the spec. Both are real,
// fully isolated headless Obsidian instances (separate sandboxed vault copies +
// user-data dirs => isolated IndexedDB), coordinated in one test.
//
// The server is pinned to the plugin's DEFAULT URL (127.0.0.1:8080) so freshly
// installed plugins connect with no settings injection. Override via YSWEET_PORT.

import * as path from "path";
import { fileURLToPath } from "url";
import { startYSweetServer, type YSweetServer } from "../support/ysweetServer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const PORT = Number(process.env.YSWEET_PORT ?? 8080);

let server: YSweetServer | undefined;

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
		server = await startYSweetServer(PORT);
	},
	async onComplete() {
		await server?.stop();
	},
};
