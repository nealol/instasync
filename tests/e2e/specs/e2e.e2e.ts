import { browser, expect } from "@wdio/globals";
import { startWdioSession } from "wdio-obsidian-service";
import * as path from "path";
import * as net from "net";
import { fileURLToPath } from "url";
import {
	readNote,
	writeNote,
	deleteNote,
	openNoteInEditor,
	typeInEditor,
	editorText,
	toggleSourceMode,
	closeAllEditors,
	listMarkdown,
	setPluginEnabled,
	installNetworkShim,
	setNetworkOffline,
	statusText,
	signInDevice,
	createVaultFromLocal,
	generateInvite,
	redeemAndAdopt,
	redeemInviteOnly,
	activeVaultId,
	listedVaultIds,
	setSyncPaused,
	docTokenStatus,
} from "./helpers.js";
import { apiCreateVault, apiPromoteMember, apiRedeemInvite, apiRemoveMember, mockLogin } from "../../support/authServer.js";

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
const AUTH_PORT = Number(process.env.AUTH_PORT ?? 8081);
const authUrl = `http://127.0.0.1:${AUTH_PORT}`;

// Device A is the wdio session (vault A). Device B is a second, fully isolated
// Obsidian instance started programmatically (vault B). Both install this plugin;
// the conf boots y-sweet (--auth) + the auth server (mock OIDC) on the plugin's
// default ports. Device A signs in and creates a vault from its local files;
// device B signs in as a different user, redeems an invite, and adopts it.
let A: WebdriverIO.Browser;
let B: WebdriverIO.Browser;
let vaultId: string;
let adminToken: string;
let bobToken: string;

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

		// Device A: sign in, seed a file, create a vault from the local files.
		adminToken = await signInDevice(A, authUrl, "alice");
		await writeNote(A, "Seed.md", "seeded on A");
		vaultId = await createVaultFromLocal(A, "shared");

		// Device B: sign in as a different user, then redeem an invite and adopt.
		// LocalOnlyB.md must be erased by the adopt; Seed.md must be pulled in.
		bobToken = await signInDevice(B, authUrl, "bob");
		await writeNote(B, "LocalOnlyB.md", "should be erased by adopt");
		const code = await generateInvite(authUrl, adminToken, vaultId);
		await redeemAndAdopt(B, code);

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

	describe("onboarding & access control", function () {
		it("adopt pulled the remote vault and erased local-only files on B", async function () {
			await B.waitUntil(async () => (await readNote(B, "Seed.md")) === "seeded on A", {
				timeout: 60 * SECONDS,
				timeoutMsg: "B never pulled the adopted vault's Seed.md",
			});
			expect(await readNote(B, "LocalOnlyB.md")).toBe(null);
		});

		it("refuses a doc token to a non-member of the vault", async function () {
			const carol = await mockLogin(authUrl, "carol");
			const res = await fetch(`${authUrl}/api/doc-token`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${carol}` },
				body: JSON.stringify({ vaultId, docId: vaultId }),
			});
			expect(res.status).toBe(403);
		});

		it("redeems an invite without adopting and keeps the current active vault", async function () {
			const other = await apiCreateVault(authUrl, adminToken, "not-active");
			const code = await generateInvite(authUrl, adminToken, other.id);
			const redeemed = await redeemInviteOnly(B, code);
			expect(redeemed.vaultId).toBe(other.id);
			expect(redeemed.activeVaultId).toBe(vaultId);
			expect(await activeVaultId(B)).toBe(vaultId);
			expect(await listedVaultIds(B)).toContain(other.id);
		});
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

		it("pause syncing stops propagation until syncing resumes", async function () {
			await setSyncPaused(A, true);
			await writeNote(B, "Paused.md", "written while A is paused");
			await A.pause(2 * SECONDS);
			expect(await readNote(A, "Paused.md")).toBe(null);

			await setSyncPaused(A, false);
			await A.waitUntil(
				async () => (await readNote(A, "Paused.md")) === "written while A is paused",
				{ timeout: 60 * SECONDS, timeoutMsg: "A did not catch up after unpausing" },
			);
		});
	});

	describe("live editing of an open note", function () {
		// Regression for the character-duplication bug: typing into an *open*
		// editor while a view-plugin teardown (mode switch) flushes Y.Text to a
		// disk that lags the editor made Obsidian report "modified externally and
		// changes have been merged in" and 3-way-merge the just-typed text back
		// into the buffer, duplicating characters (and re-sending them to peers).
		// The plain modify/read sync tests can't see this — only a real editor can.
		it("does not duplicate characters when editing through mode switches", async function () {
			const text = "The quick brown fox jumps over the lazy dog";

			await writeNote(A, "Live.md", "");
			await B.waitUntil(async () => (await readNote(B, "Live.md")) === "", {
				timeout: 60 * SECONDS,
				timeoutMsg: "B never received the empty Live.md",
			});

			await openNoteInEditor(A, "Live.md");

			// Interleave typing with view-plugin teardowns while the disk lags the
			// editor (we never pause for Obsidian's autosave between type + toggle).
			await typeInEditor(A, "Live.md", "The quick brown fox ");
			await toggleSourceMode(A); // -> raw source: editor torn down + rebuilt
			await toggleSourceMode(A); // -> live preview: torn down + rebuilt again
			await typeInEditor(A, "Live.md", "jumps over the lazy dog");
			await toggleSourceMode(A);
			await toggleSourceMode(A);

			try {
				// The live editor buffer must be exactly what was typed — any
				// external-merge would have duplicated characters here. (Disk lags:
				// we never write while the file is open, so assert the buffer.)
				await A.waitUntil(async () => (await editorText(A, "Live.md")) === text, {
					timeout: 30 * SECONDS,
					timeoutMsg: `A's editor buffer was corrupted: "${await editorText(A, "Live.md")}"`,
				});
				// And the duplication must not have propagated: B converges to the
				// exact text, with no extra characters.
				await B.waitUntil(async () => (await readNote(B, "Live.md")) === text, {
					timeout: 60 * SECONDS,
					timeoutMsg: `B did not converge to the typed text: "${await readNote(B, "Live.md")}"`,
				});
				// Closing the only editor flushes the (clean) buffer to A's disk.
				await closeAllEditors(A);
				await A.waitUntil(async () => (await readNote(A, "Live.md")) === text, {
					timeout: 30 * SECONDS,
					timeoutMsg: `A's disk did not match after close: "${await readNote(A, "Live.md")}"`,
				});
			} finally {
				await closeAllEditors(A);
				await deleteNote(A, "Live.md");
			}
		});

		it("converges without duplicating when both devices edit the open note", async function () {
			// The collaborative case that stresses the editor↔Y.Text binding: both
			// devices have the note open and type concurrently. A binding that maps
			// CodeMirror offsets onto stale Y.Text positions duplicates characters
			// here; a self-healing diff binding converges to exactly the typed chars.
			await writeNote(A, "Co.md", "");
			await B.waitUntil(async () => (await readNote(B, "Co.md")) === "", {
				timeout: 60 * SECONDS,
				timeoutMsg: "B never received the empty Co.md",
			});

			await openNoteInEditor(A, "Co.md");
			await openNoteInEditor(B, "Co.md");

			// Interleave keystrokes on both devices so remote applies and local
			// pushes land in the same editor update cycles.
			for (let i = 0; i < 6; i++) {
				await typeInEditor(A, "Co.md", "aa");
				await typeInEditor(B, "Co.md", "bb");
			}

			try {
				const expectedA = 12;
				const expectedB = 12;
				// Both editors must converge to the SAME text...
				let last = { a: "", b: "" };
				await A.waitUntil(
					async () => {
						last.a = (await editorText(A, "Co.md")) ?? "";
						last.b = (await editorText(B, "Co.md")) ?? "";
						return last.a.length > 0 && last.a === last.b;
					},
					{
						timeout: 60 * SECONDS,
						timeoutMsg: "editors never converged",
					},
				);
				// ...and that text must contain exactly the characters typed — no
				// duplicates (would be >12) and no losses (<12).
				const converged = last.a;
				const aCount = converged.split("").filter((c) => c === "a").length;
				const bCount = converged.split("").filter((c) => c === "b").length;
				expect(`${aCount}/${bCount}/${converged.length}`).toBe(
					`${expectedA}/${expectedB}/${expectedA + expectedB}`,
				);
			} finally {
				await closeAllEditors(A);
				await closeAllEditors(B);
				await deleteNote(A, "Co.md");
			}
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
			await A.pause(SECONDS); // persist baseline to A's IndexedDB

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

	describe("vault administration", function () {
		it("allows admins to remove members but not admins", async function () {
			const bobMe = await fetch(`${authUrl}/api/me`, { headers: { Authorization: `Bearer ${bobToken}` } }).then((res) => res.json() as Promise<{ userId: string }>);
			await apiPromoteMember(authUrl, adminToken, vaultId, bobMe.userId);

			const charlie = await mockLogin(authUrl, "charlie");
			const charlieMe = await fetch(`${authUrl}/api/me`, { headers: { Authorization: `Bearer ${charlie}` } }).then((res) => res.json() as Promise<{ userId: string }>);
			await apiRedeemInvite(authUrl, charlie, await generateInvite(authUrl, adminToken, vaultId));
			expect(await apiRemoveMember(authUrl, bobToken, vaultId, charlieMe.userId)).toBe(200);

			const dave = await mockLogin(authUrl, "dave");
			const daveMe = await fetch(`${authUrl}/api/me`, { headers: { Authorization: `Bearer ${dave}` } }).then((res) => res.json() as Promise<{ userId: string }>);
			await apiRedeemInvite(authUrl, dave, await generateInvite(authUrl, adminToken, vaultId));
			await apiPromoteMember(authUrl, adminToken, vaultId, daveMe.userId);
			expect(await apiRemoveMember(authUrl, bobToken, vaultId, daveMe.userId)).toBe(403);
		});

		it("allows the owner to remove an admin and revokes that device's access", async function () {
			const bobMe = await fetch(`${authUrl}/api/me`, { headers: { Authorization: `Bearer ${bobToken}` } }).then((res) => res.json() as Promise<{ userId: string }>);
			expect(await apiRemoveMember(authUrl, adminToken, vaultId, bobMe.userId)).toBe(200);
			expect(await docTokenStatus(B, vaultId)).toBe("refused");
		});
	});
});
