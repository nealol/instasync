import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CursorClient, RealtimeClient, AuthError, type VaultHandle } from "../../src/index";
import { loginCursorViaOAuth } from "../../src/node";
import { startAuthHarness, fetchBrowser, type AuthHarness } from "../support/harness";

let harness: AuthHarness;
let admin: RealtimeClient;
let vaultId: string;
let vault: VaultHandle;

beforeAll(async () => {
	harness = await startAuthHarness();
	admin = new RealtimeClient({ baseUrl: harness.authUrl, token: await harness.loginUser("alice") });
	vaultId = (await admin.vaults.create("Cursor Vault")).id;
	vault = admin.vault(vaultId);
});

afterAll(async () => {
	await harness?.stop();
});

describe("cursor management", () => {
	it("creates, renames, regenerates, and deletes cursors", async () => {
		const created = await vault.cursors.create("Robot A");
		expect(created.secretToken).toBeTruthy();
		expect(created.mcpUrl).toContain(`/mcp/i/${created.appId}`);

		const renamed = await vault.cursors.rename(created.id, "Robot B");
		expect(renamed.name).toBe("Robot B");

		const { secretToken: fresh } = await vault.cursors.regenerateToken(created.id);
		expect(fresh).not.toBe(created.secretToken);

		// The old token is dead, the new one works.
		const stale = new CursorClient({ baseUrl: harness.authUrl, vaultId, token: created.secretToken });
		await expect(stale.notes.list()).rejects.toThrow(AuthError);
		const live = new CursorClient({ baseUrl: harness.authUrl, vaultId, token: fresh });
		await live.notes.list();

		await vault.cursors.delete(created.id);
		expect((await vault.cursors.list()).find((c) => c.id === created.id)).toBeUndefined();
	});
});

describe("cursor note edits + audit log", () => {
	it("edits as the cursor, lists the audit trail, and undoes an entry", async () => {
		const created = await vault.cursors.create("Auditor");
		const cursor = new CursorClient({ baseUrl: harness.authUrl, vaultId, token: created.secretToken });

		await cursor.notes.create("Audited.md", "original");
		await cursor.notes.replace("Audited.md", "tampered");
		expect((await vault.notes.read("Audited.md")).content).toBe("tampered");

		const audit = vault.cursors.audit(created.id);
		const page = await audit.list();
		expect(page.entries.length).toBeGreaterThanOrEqual(2);
		const replaceEntry = page.entries.find((e) => e.operation.includes("replace") || e.beforeContent === "original");
		expect(replaceEntry).toBeTruthy();

		await audit.undo(replaceEntry!.id);
		expect((await vault.notes.read("Audited.md")).content).toBe("original");

		const after = await audit.list();
		expect(after.entries.find((e) => e.id === replaceEntry!.id)?.undoneAt).toBeTruthy();
	});
});

describe("OAuth 2.1 PKCE delegation", () => {
	it("runs the full registration → authorize → exchange flow headlessly", async () => {
		const created = await vault.cursors.create("OAuth Robot");

		// alice created the cursor, so alice must be the authorizing identity.
		const session = await loginCursorViaOAuth({
			baseUrl: harness.authUrl,
			mcpUrl: created.mcpUrl,
			openBrowser: fetchBrowser("alice"),
		});
		expect(session.tokens.accessToken).toBeTruthy();
		expect(session.tokens.tokenType).toBe("Bearer");
		expect(session.tokens.expiresIn).toBe(3600);

		const cursor = new CursorClient({
			baseUrl: harness.authUrl,
			vaultId,
			tokenProvider: session.tokenProvider,
		});
		const note = await cursor.notes.create("OAuth.md", "via oauth");
		expect(note.content).toBe("via oauth");

		// Robot edits are attributed to the cursor in the audit log.
		const page = await vault.cursors.audit(created.id).list();
		expect(page.entries.some((e) => e.path === "OAuth.md")).toBe(true);
	});

	it("refuses authorization from a user who does not own the cursor", async () => {
		const created = await vault.cursors.create("Owned Robot");
		await expect(
			loginCursorViaOAuth({
				baseUrl: harness.authUrl,
				mcpUrl: created.mcpUrl,
				openBrowser: fetchBrowser("mallory"),
			}),
		).rejects.toThrow();
	});

	it("refresh tokens mint new working access tokens", async () => {
		const created = await vault.cursors.create("Refresh Robot");
		const session = await loginCursorViaOAuth({
			baseUrl: harness.authUrl,
			mcpUrl: created.mcpUrl,
			openBrowser: fetchBrowser("alice"),
		});

		const fresh = await session.tokenProvider.onUnauthorized();
		expect(fresh).toBeTruthy();
		expect(fresh).not.toBe(session.tokens.accessToken);

		const cursor = new CursorClient({ baseUrl: harness.authUrl, vaultId, token: fresh! });
		await cursor.notes.list();
	});
});
