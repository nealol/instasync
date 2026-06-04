import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Document } from "../../src/Document";
import { makeFakePlugin, type FakeVault } from "../support/fakePlugin";
import { notices } from "../support/obsidian-mock";
import { Peer } from "../support/peer";
import { startYSweetServer, type YSweetServer } from "../support/ysweetServer";
import { waitFor, freshGuid } from "../support/util";

let server: YSweetServer;

beforeAll(async () => {
	server = await startYSweetServer();
}, 120_000);

afterAll(async () => {
	await server?.stop();
});

afterEach(() => {
	notices.length = 0;
});

/** Build a Document (client "A") over a fresh fake vault, optionally preloaded. */
function makeDoc(
	guid: string,
	opts: { file?: { path: string; content: string }; clientName?: string } = {},
) {
	const { plugin, vault } = makeFakePlugin(server.url, { clientName: opts.clientName });
	if (opts.file) vault.files.set(opts.file.path, opts.file.content);
	const doc = new Document(plugin as any, opts.file?.path ?? "note.md", guid, true);
	return { doc, vault, plugin };
}

const conflictFiles = (vault: FakeVault) =>
	[...vault.files.keys()].filter((p) => /\(conflicted copy /.test(p));

describe("Document sync", () => {
	it("propagates local and remote edits (clean, no conflict)", async () => {
		const guid = freshGuid();
		const { doc, vault } = makeDoc(guid, { file: { path: "note.md", content: "seed" } });
		const peer = new Peer(server.url, guid);
		try {
			await doc.whenReady();
			await peer.whenSynced();

			// A's seeded content reaches B.
			await waitFor(() => peer.getText() === "seed", { label: "B sees seed" });

			// Remote edit from B lands on A's disk (no editor bound).
			peer.setText("seed + remote");
			await waitFor(() => vault.files.get("note.md") === "seed + remote", {
				label: "A disk has remote edit",
			});

			// Local disk edit on A propagates to B.
			vault.files.set("note.md", "local update");
			await doc.onDiskChanged();
			await waitFor(() => peer.getText() === "local update", { label: "B sees local edit" });

			expect(conflictFiles(vault)).toHaveLength(0);
			expect(notices).toHaveLength(0);
		} finally {
			doc.destroy();
			peer.destroy();
		}
	});

	it("pure remote update writes to disk without a conflict copy", async () => {
		const guid = freshGuid();
		// Seed the server from B first.
		const peer = new Peer(server.url, guid);
		await peer.whenSynced();
		peer.setText("authored elsewhere");

		// A starts with no local file at all.
		const { plugin, vault } = makeFakePlugin(server.url);
		const doc = new Document(plugin as any, "note.md", guid, false);
		try {
			await doc.whenReady();
			await waitFor(() => vault.files.get("note.md") === "authored elsewhere", {
				label: "A disk seeded from remote",
			});
			expect(conflictFiles(vault)).toHaveLength(0);
			expect(notices).toHaveLength(0);
		} finally {
			doc.destroy();
			peer.destroy();
		}
	});

	it("startup conflict: merges divergent offline writes and saves a conflict copy", async () => {
		const guid = freshGuid();
		const peer = new Peer(server.url, guid);

		// Phase 1 — establish a shared baseline "base" and persist it to A's IndexedDB.
		const a1 = makeDoc(guid, {
			file: { path: "note.md", content: "base" },
			clientName: "Brave Otter",
		});
		await a1.doc.whenReady();
		await peer.whenSynced();
		await waitFor(() => peer.getText() === "base", { label: "baseline synced" });
		await new Promise((r) => setTimeout(r, 250)); // let IndexedDB persist the baseline
		a1.doc.destroy();

		// Phase 2 — while A is gone, both sides diverge from the baseline.
		peer.setText("base REMOTE side");
		a1.vault.files.set("note.md", "base LOCAL side"); // external offline edit on A's disk

		// Phase 3 — A restarts on the same guid + vault (baseline reloads from IndexedDB).
		const { plugin } = makeFakePlugin(server.url, { clientName: "Brave Otter" });
		(plugin.app.vault as FakeVault).files = a1.vault.files; // same on-disk state
		const a2 = new Document(plugin as any, "note.md", guid, false);
		try {
			await a2.whenReady();
			await waitFor(() => peer.getText() === a2.content && a2.content.length > 0, {
				timeout: 15_000,
				label: "A2 and B converge",
			});

			// Both sides agree (CRDT merge) and nothing was clobbered.
			expect(a2.content).toBe(peer.getText());
			expect(a2.content).not.toBe("base LOCAL side"); // remote edits were merged in

			// The user's pre-merge local version was preserved and surfaced.
			const copies = conflictFiles(plugin.app.vault as FakeVault);
			expect(copies).toHaveLength(1);
			expect((plugin.app.vault as FakeVault).files.get(copies[0])).toBe("base LOCAL side");
			expect(copies[0]).toMatch(/Brave Otter/);
			expect(notices.some((n) => /conflicted copy/i.test(n))).toBe(true);

			// The merged text was written back to the live file.
			expect((plugin.app.vault as FakeVault).files.get("note.md")).toBe(a2.content);
		} finally {
			a2.destroy();
			peer.destroy();
		}
	});

	it("restart durability: offline edits persist across a restart via IndexedDB", async () => {
		const guid = freshGuid();
		const a1 = makeDoc(guid, { file: { path: "note.md", content: "" } });
		await a1.doc.whenReady();
		await waitFor(() => a1.doc.provider.status === "connected", { label: "A1 connected" });

		// Go offline, then make a local edit that only IndexedDB captures.
		a1.doc.provider.disconnect();
		a1.vault.files.set("note.md", "written while offline");
		await a1.doc.onDiskChanged();
		await new Promise((r) => setTimeout(r, 250)); // persist to IndexedDB
		a1.doc.destroy();

		// Restart on the same guid; the offline edit must survive (no server needed).
		const { plugin } = makeFakePlugin(server.url);
		(plugin.app.vault as FakeVault).files = a1.vault.files;
		const a2 = new Document(plugin as any, "note.md", guid, false);
		try {
			await a2.whenReady();
			expect(a2.content).toBe("written while offline");
		} finally {
			a2.destroy();
		}
	});

	it("reconnect: ensureConnected revives a disconnected provider", async () => {
		const guid = freshGuid();
		const { doc, vault } = makeDoc(guid, { file: { path: "note.md", content: "hi" } });
		const peer = new Peer(server.url, guid);
		try {
			await doc.whenReady();
			await waitFor(() => doc.provider.status === "connected");

			doc.provider.disconnect();
			await waitFor(() => doc.provider.status === "offline", { label: "went offline" });

			doc.ensureConnected();
			await waitFor(() => doc.provider.status === "connected", { label: "reconnected" });

			// Sync resumes after reconnect.
			peer.setText("after reconnect");
			await waitFor(() => vault.files.get("note.md") === "after reconnect", {
				label: "sync resumed",
			});
		} finally {
			doc.destroy();
			peer.destroy();
		}
	});
});
