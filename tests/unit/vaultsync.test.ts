import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as Y from "yjs";
import { YSweetProvider } from "@y-sweet/client";
import { VaultSync } from "../../src/VaultSync";
import { getClientToken } from "../../src/ysweet";
import { makeFakePlugin } from "../support/fakePlugin";
import { startYSweetServer, type YSweetServer } from "../support/ysweetServer";
import { waitFor, freshGuid } from "../support/util";

let server: YSweetServer;

beforeAll(async () => {
	server = await startYSweetServer();
}, 120_000);

afterAll(async () => {
	await server?.stop();
});

/** A bare peer onto the shared vault index (the path -> guid `files` map). */
function makeIndexPeer(vaultId: string) {
	const doc = new Y.Doc();
	const provider = new YSweetProvider(
		() => getClientToken(server.url, vaultId) as any,
		vaultId,
		doc,
		{ connect: true, showDebuggerLink: false },
	);
	return { doc, files: doc.getMap<string>("files"), provider };
}

describe("VaultSync index", () => {
	it("propagates create / delete / rename and skips conflict copies", async () => {
		const vaultId = "idx-" + freshGuid();
		const peer = makeIndexPeer(vaultId);

		const { plugin, vault } = makeFakePlugin(server.url, { vaultId });
		vault.files.set("a.md", "alpha"); // one pre-existing file
		const sync = new VaultSync(plugin as any);

		try {
			// Initial sync registers the existing file and propagates to the peer.
			await waitFor(() => peer.files.has("a.md"), { timeout: 15_000, label: "a.md indexed" });

			// Local create propagates.
			await vault.create("b.md", "bravo");
			await waitFor(() => peer.files.has("b.md"), { label: "b.md indexed" });

			// A conflict-copy file must NOT be indexed / synced.
			await vault.create("a (conflicted copy Brave Otter 2026-06-02 120000).md", "alpha-local");
			await new Promise((r) => setTimeout(r, 400)); // give any erroneous sync a chance
			const indexedConflict = [...peer.files.keys()].some((p) => /conflicted copy/.test(p));
			expect(indexedConflict).toBe(false);

			// Delete removes the entry.
			const bFile = vault.getAbstractFileByPath("b.md")!;
			await vault.delete(bFile);
			await waitFor(() => !peer.files.has("b.md"), { label: "b.md unindexed" });

			// Rename moves the entry.
			vault.rename("a.md", "c.md");
			await waitFor(() => peer.files.has("c.md") && !peer.files.has("a.md"), {
				label: "a.md -> c.md",
			});
		} finally {
			sync.destroy();
			peer.provider.destroy();
			peer.doc.destroy();
		}
	});
});
