import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Document } from "../../src/Document";
import { makeFakePlugin, type FakePlugin, type FakeVault } from "../support/fakePlugin";
import { notices } from "../support/obsidian-mock";
import { Peer } from "../support/peer";
import { startAuthHarness, type AuthHarness } from "../support/authServer";
import { waitFor, freshGuid } from "../support/util";

const modalMock = vi.hoisted(() => ({
	choice: "local" as "local" | "remote",
	calls: [] as Array<{ path: string; localContent: string; remoteContent: string }>,
}));

vi.mock("../../src/TextConflictModal", () => ({
	openTextConflictModal: async (_plugin: unknown, info: { path: string; localContent: string; remoteContent: string }) => {
		modalMock.calls.push(info);
		return modalMock.choice;
	},
}));

let harness: AuthHarness;
let token: string;
let vaultId: string;
let memberPlugin: FakePlugin;

beforeAll(async () => {
	harness = await startAuthHarness();
	token = await harness.loginUser("alice");
	const vault = await harness.createVault(token, "docs");
	vaultId = vault.id;
	memberPlugin = makeFakePlugin(harness.authUrl, {
		sessionToken: token,
		activeVaultId: vaultId,
	}).plugin;
}, 180_000);

afterAll(async () => {
	await harness?.stop();
});

afterEach(() => {
	notices.length = 0;
	modalMock.choice = "local";
	modalMock.calls.length = 0;
});

/** The vault-namespaced doc id for a bare guid. */
const docId = (guid: string) => `${vaultId}__${guid}`;

/** Build a Document (client "A") over a fresh fake vault, optionally preloaded. */
function makeDoc(
	guid: string,
	opts: { file?: { path: string; content: string }; clientName?: string } = {},
) {
	const { plugin, vault } = makeFakePlugin(harness.authUrl, {
		sessionToken: token,
		activeVaultId: vaultId,
		clientName: opts.clientName,
	});
	if (opts.file) vault.files.set(opts.file.path, opts.file.content);
	const doc = new Document(plugin as any, opts.file?.path ?? "note.md", guid, docId(guid), true);
	return { doc, vault, plugin };
}

const conflictFiles = (vault: FakeVault) =>
	[...vault.files.keys()].filter((p) => /\(conflicted copy /.test(p));

describe("Document sync", () => {
	it("propagates local and remote edits (clean, no conflict)", async () => {
		const guid = freshGuid();
		const { doc, vault } = makeDoc(guid, { file: { path: "note.md", content: "seed" } });
		const peer = new Peer(memberPlugin, docId(guid));
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
		const peer = new Peer(memberPlugin, docId(guid));
		await peer.whenSynced();
		peer.setText("authored elsewhere");

		// A starts with no local file at all.
		const { plugin, vault } = makeFakePlugin(harness.authUrl, {
			sessionToken: token,
			activeVaultId: vaultId,
		});
		const doc = new Document(plugin as any, "note.md", guid, docId(guid), false);
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

	it("does not write remote updates to disk while the note is open", async () => {
		const guid = freshGuid();
		const { plugin, vault } = makeFakePlugin(harness.authUrl, {
			sessionToken: token,
			activeVaultId: vaultId,
		});
		vault.files.set("note.md", "local buffer");
		(plugin.app.workspace as any).getLeavesOfType = () => [
			{ view: { file: { path: "note.md" } } },
		];

		const doc = new Document(plugin as any, "note.md", guid, docId(guid), true);
		const peer = new Peer(memberPlugin, docId(guid));
		try {
			await doc.whenReady();
			await peer.whenSynced();
			await waitFor(() => peer.getText() === "local buffer", { label: "seed synced" });

			peer.setText("remote update");
			await waitFor(() => doc.content === "remote update", { label: "remote reached doc" });
			await new Promise((r) => setTimeout(r, 250));

			expect(vault.files.get("note.md")).toBe("local buffer");
		} finally {
			doc.destroy();
			peer.destroy();
		}
	});

	it("does not ingest disk modify events while the note is open", async () => {
		const guid = freshGuid();
		const { plugin, vault } = makeFakePlugin(harness.authUrl, {
			sessionToken: token,
			activeVaultId: vaultId,
		});
		vault.files.set("note.md", "shared buffer");
		(plugin.app.workspace as any).getLeavesOfType = () => [
			{ view: { file: { path: "note.md" } } },
		];

		const doc = new Document(plugin as any, "note.md", guid, docId(guid), true);
		const peer = new Peer(memberPlugin, docId(guid));
		try {
			await doc.whenReady();
			await peer.whenSynced();
			await waitFor(() => peer.getText() === "shared buffer", { label: "seed synced" });

			vault.files.set("note.md", "disk save snapshot");
			await doc.onDiskChanged();
			await new Promise((r) => setTimeout(r, 250));

			expect(doc.content).toBe("shared buffer");
			expect(peer.getText()).toBe("shared buffer");
		} finally {
			doc.destroy();
			peer.destroy();
		}
	});

	it("does not write a scheduled disk update if the note opens during the debounce", async () => {
		// The race behind the "modified externally / changes merged in" bug: a remote
		// edit arrives while the note is closed and schedules a disk write; the user
		// opens the note within the 100ms debounce window. The write must re-check at
		// fire time and skip — otherwise vault.modify hits the open file and Obsidian
		// 3-way-merges it, duplicating characters.
		const guid = freshGuid();
		const { plugin, vault } = makeFakePlugin(harness.authUrl, {
			sessionToken: token,
			activeVaultId: vaultId,
		});
		vault.files.set("note.md", "base");
		// Note starts closed: the default workspace mock reports no open leaves.

		const doc = new Document(plugin as any, "note.md", guid, docId(guid), true);
		const peer = new Peer(memberPlugin, docId(guid));
		try {
			await doc.whenReady();
			await peer.whenSynced();
			await waitFor(() => peer.getText() === "base", { label: "seed synced" });

			// Remote edit lands -> onYTextChanged schedules a 100ms disk write.
			peer.setText("base + remote");
			await waitFor(() => doc.content === "base + remote", { label: "remote reached doc" });
			// Open the note before the debounce timer fires.
			(plugin.app.workspace as any).getLeavesOfType = () => [
				{ view: { file: { path: "note.md" } } },
			];
			await new Promise((r) => setTimeout(r, 250));

			expect(vault.files.get("note.md")).toBe("base");
		} finally {
			doc.destroy();
			peer.destroy();
		}
	});

	it("does not flush to disk when an editor unbinds while the note stays open", async () => {
		// Obsidian tears down and immediately recreates the editor's view plugins on
		// mode switches; the transient unbind must not vault.modify an open file
		// (that surfaces as an external change Obsidian merges, duplicating text).
		const guid = freshGuid();
		const { plugin, vault } = makeFakePlugin(harness.authUrl, {
			sessionToken: token,
			activeVaultId: vaultId,
		});
		vault.files.set("note.md", "disk lags editor");
		(plugin.app.workspace as any).getLeavesOfType = () => [
			{ view: { file: { path: "note.md" } } },
		];

		const doc = new Document(plugin as any, "note.md", guid, docId(guid), true);
		const peer = new Peer(memberPlugin, docId(guid));
		try {
			await doc.whenReady();
			await peer.whenSynced();
			await waitFor(() => peer.getText() === "disk lags editor", { label: "seed synced" });

			// Editor holds newer content than disk (Obsidian hasn't autosaved yet).
			doc.bindEditor();
			peer.setText("disk lags editor +typed");
			await waitFor(() => doc.content === "disk lags editor +typed", { label: "edit reached doc" });

			doc.unbindEditor();
			await new Promise((r) => setTimeout(r, 250));

			// File still open => no write, so Obsidian never sees an external change.
			expect(vault.files.get("note.md")).toBe("disk lags editor");
		} finally {
			doc.destroy();
			peer.destroy();
		}
	});

	it("startup conflict: prompts and accepts local as the canonical version", async () => {
		const guid = freshGuid();
		const peer = new Peer(memberPlugin, docId(guid));

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
		const { plugin } = makeFakePlugin(harness.authUrl, {
			sessionToken: token,
			activeVaultId: vaultId,
			clientName: "Brave Otter",
		});
		(plugin.app.vault as FakeVault).files = a1.vault.files; // same on-disk state
		const a2 = new Document(plugin as any, "note.md", guid, docId(guid), false);
		try {
			await a2.whenReady();
			await waitFor(() => peer.getText() === a2.content && a2.content.length > 0, {
				timeout: 15_000,
				label: "A2 and B converge",
			});

			// Both sides agree on the explicitly selected local version.
			expect(a2.content).toBe(peer.getText());
			expect(a2.content).toBe("base LOCAL side");

			expect(modalMock.calls).toEqual([
				{
					path: "note.md",
					localContent: "base LOCAL side",
					remoteContent: "base REMOTE side",
				},
			]);
			expect(conflictFiles(plugin.app.vault as FakeVault)).toHaveLength(0);
			expect(notices.some((n) => /kept your local version/i.test(n))).toBe(true);

			// The canonical text was written back to the live file.
			expect((plugin.app.vault as FakeVault).files.get("note.md")).toBe(a2.content);
		} finally {
			a2.destroy();
			peer.destroy();
		}
	});

	it("startup conflict: accepts remote as the canonical version without a conflict copy", async () => {
		modalMock.choice = "remote";
		const guid = freshGuid();
		const peer = new Peer(memberPlugin, docId(guid));

		const a1 = makeDoc(guid, { file: { path: "note.md", content: "base" } });
		await a1.doc.whenReady();
		await peer.whenSynced();
		await waitFor(() => peer.getText() === "base", { label: "baseline synced" });
		await new Promise((r) => setTimeout(r, 250));
		a1.doc.destroy();

		peer.setText("base REMOTE side");
		a1.vault.files.set("note.md", "base LOCAL side");

		const { plugin } = makeFakePlugin(harness.authUrl, {
			sessionToken: token,
			activeVaultId: vaultId,
			clientName: "Brave Otter",
		});
		(plugin.app.vault as FakeVault).files = a1.vault.files;
		const a2 = new Document(plugin as any, "note.md", guid, docId(guid), false);
		try {
			await a2.whenReady();
			await waitFor(() => peer.getText() === "base REMOTE side", {
				timeout: 15_000,
				label: "remote remains canonical",
			});

			expect(a2.content).toBe("base REMOTE side");
			expect(modalMock.calls).toHaveLength(1);
			expect(conflictFiles(plugin.app.vault as FakeVault)).toHaveLength(0);
			expect((plugin.app.vault as FakeVault).files.get("note.md")).toBe("base REMOTE side");
			expect(notices.some((n) => /kept the remote version/i.test(n))).toBe(true);
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
		const { plugin } = makeFakePlugin(harness.authUrl, {
			sessionToken: token,
			activeVaultId: vaultId,
		});
		(plugin.app.vault as FakeVault).files = a1.vault.files;
		const a2 = new Document(plugin as any, "note.md", guid, docId(guid), false);
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
		const peer = new Peer(memberPlugin, docId(guid));
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
