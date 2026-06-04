import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startYSweetServer, type YSweetServer } from "../support/ysweetServer";
import { Peer } from "../support/peer";
import { waitFor, freshGuid } from "../support/util";

describe("harness smoke", () => {
	let server: YSweetServer;

	beforeAll(async () => {
		server = await startYSweetServer();
	}, 120_000);

	afterAll(async () => {
		await server?.stop();
	});

	it("two peers sync text through the spawned y-sweet server", async () => {
		const guid = freshGuid();
		const a = new Peer(server.url, guid);
		const b = new Peer(server.url, guid);
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
