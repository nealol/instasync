import { browser, expect } from "@wdio/globals";
import { startWdioSession } from "wdio-obsidian-service";
import * as path from "path";
import * as net from "net";
import { fileURLToPath } from "url";
import {
	readNote,
	writeNote,
	deleteNote,
	listMarkdown,
	setPluginEnabled,
	installNetworkShim,
	setNetworkOffline,
	statusText,
} from "./helpers.js";

/** Reserve then release a port so nothing listens on it — a dead endpoint. */
function reserveDeadPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
	});
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const vaultB = path.resolve(here, "../vaults/vaultB");
const cacheDir = path.resolve(repoRoot, ".obsidian-cache");

const SECONDS = 1000;

// Device A is the wdio session (vault A). Device B is a second, fully isolated
// Obsidian instance started programmatically (vault B). Both install this plugin
// and use its default settings (127.0.0.1:8080, vaultId "instasync-vault"), so
// they sync through the server the conf spawned.
let A: WebdriverIO.Browser;
let B: WebdriverIO.Browser;

describe("InstaSync — two isolated Obsidian devices", function () {
	before(async function () {
		A = browser;
		B = await startWdioSession({
			capabilities: {
				browserName: "obsidian",
				browserVersion: "latest",
				"wdio:obsidianOptions": {
					installerVersion: "earliest",
					plugins: [repoRoot],
					vault: vaultB,
					copy: true,
				},
			},
			cacheDir,
		} as any);

		// Wait until both devices are connected ("live") before exercising sync.
		for (const dev of [A, B]) {
			await dev.waitUntil(async () => /live/i.test(await statusText(dev)), {
				timeout: 90 * SECONDS,
				timeoutMsg: "device never reached 'live'",
			});
		}

		// Install the WebSocket network-cut shim on device A, then reload its plugin
		// so the providers capture the shimmed `window.WebSocket`.
		const deadPort = await reserveDeadPort();
		await installNetworkShim(A, deadPort);
		await setPluginEnabled(A, false);
		await setPluginEnabled(A, true);
		await A.waitUntil(async () => /live/i.test(await statusText(A)), {
			timeout: 90 * SECONDS,
			timeoutMsg: "A did not reconnect after installing the network shim",
		});
	});

	after(async function () {
		await B?.deleteSession();
	});

	describe("live sync", function () {
		it("propagates a new note A -> B", async function () {
			await writeNote(A, "Shared.md", "hello from A");
			await B.waitUntil(async () => (await readNote(B, "Shared.md")) === "hello from A", {
				timeout: 60 * SECONDS,
				timeoutMsg: "B never received Shared.md",
			});
		});

		it("propagates an edit B -> A", async function () {
			await writeNote(B, "Shared.md", "hello from A and B");
			await A.waitUntil(
				async () => (await readNote(A, "Shared.md")) === "hello from A and B",
				{ timeout: 60 * SECONDS, timeoutMsg: "A never received B's edit" },
			);
		});

		it("propagates a deletion A -> B", async function () {
			await deleteNote(A, "Shared.md");
			await B.waitUntil(async () => (await readNote(B, "Shared.md")) === null, {
				timeout: 60 * SECONDS,
				timeoutMsg: "B still has the deleted note",
			});
		});
	});

	describe("offline divergence -> conflict copy", function () {
		// The conflicted-copy backup is a startup-path artifact: it fires when a file
		// changed on disk while the Document was not tracking it AND the shared doc
		// also advanced. We model "offline & not tracking" by disabling the plugin,
		// editing the file externally, then re-enabling it (no production changes).
		it("saves the offline device's pre-merge copy and merges the rest", async function () {
			await writeNote(A, "Conflict.md", "base");
			await B.waitUntil(async () => (await readNote(B, "Conflict.md")) === "base", {
				timeout: 60 * SECONDS,
				timeoutMsg: "baseline never reached B",
			});
			await A.pause(1 * SECONDS); // persist baseline to A's IndexedDB

			await setPluginEnabled(A, false); // A goes offline & stops tracking

			await writeNote(A, "Conflict.md", "base + LOCAL while offline");
			await writeNote(B, "Conflict.md", "base + REMOTE online");
			await B.pause(2 * SECONDS); // let B sync to the server

			await setPluginEnabled(A, true); // A restarts -> startup reconcile + conflict

			await A.waitUntil(
				async () => {
					const a = await readNote(A, "Conflict.md");
					const b = await readNote(B, "Conflict.md");
					return !!a && !!b && a === b;
				},
				{ timeout: 60 * SECONDS, timeoutMsg: "devices did not converge" },
			);

			// Scope to Conflict.md (the file under test) so unrelated files can't
			// influence the assertion.
			const isConflictCopy = (p: string) => /^Conflict \(conflicted copy .+\)\.md$/.test(p);
			const aCopies = (await listMarkdown(A)).filter(isConflictCopy);
			const bCopies = (await listMarkdown(B)).filter(isConflictCopy);
			expect(aCopies.length).toBe(1); // A (the offline device) kept its copy
			expect(bCopies.length).toBe(0); // B never made one; A's copy did not sync
			expect(await readNote(A, aCopies[0])).toBe("base + LOCAL while offline");
		});
	});

	describe("network drop -> reconnect", function () {
		// Cuts device A's network at the WebSocket layer (see installNetworkShim),
		// then restores it, asserting the plugin drops out of "live" and recovers.
		it("recovers connectivity and resumes sync after a network drop", async function () {
			await setNetworkOffline(A, true);
			await A.waitUntil(async () => !/live/i.test(await statusText(A)), {
				timeout: 30 * SECONDS,
				timeoutMsg: "A still 'live' after the network was cut",
			});

			await setNetworkOffline(A, false);
			await A.waitUntil(async () => /live/i.test(await statusText(A)), {
				timeout: 60 * SECONDS,
				timeoutMsg: "A did not return to 'live' after the network was restored",
			});

			await writeNote(B, "Reconnect.md", "after reconnect");
			await A.waitUntil(
				async () => (await readNote(A, "Reconnect.md")) === "after reconnect",
				{ timeout: 60 * SECONDS, timeoutMsg: "sync did not resume after reconnect" },
			);
		});
	});
});
