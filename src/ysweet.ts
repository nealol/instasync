import type RealtimePlugin from "./main";

/** Subset of the y-sweet client token needed to connect (see y-sweet SDK). */
export type ClientToken = {
	url: string;
	baseUrl: string;
	docId: string;
	token?: string;
	authorization?: "full" | "read-only";
};

const TOKEN_RETRY_DELAY_MS = 30_000;

let nextTokenAttemptAt = 0;
let tokenAttemptQueue: Promise<void> = Promise.resolve();

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForTokenAttemptSlot(): Promise<() => void> {
	let release!: () => void;
	const previous = tokenAttemptQueue;
	tokenAttemptQueue = new Promise((resolve) => {
		release = resolve;
	});
	await previous;
	return release;
}

/**
 * Obtains a y-sweet {@link ClientToken} for a document by asking the Realtime
 * auth server to mint one. The server performs the access checks and relays to
 * y-sweet, so the plugin never talks to y-sweet's HTTP API directly.
 *
 * `docId` is the *namespaced* id (`{vaultId}` for the index, `{vaultId}__{guid}`
 * for a file); the vault is always the active vault.
 */
export async function getClientToken(plugin: RealtimePlugin, docId: string): Promise<ClientToken> {
	const vaultId = plugin.settings.activeVaultId;
	if (!vaultId) {
		throw new Error("Realtime: no active vault selected.");
	}

	const release = await waitForTokenAttemptSlot();
	try {
		const waitMs = nextTokenAttemptAt - Date.now();
		if (waitMs > 0) await delay(waitMs);

		const token = await plugin.auth.docToken(vaultId, docId);
		nextTokenAttemptAt = 0;
		if (!token || !token.url) {
			throw new Error(`Realtime: auth server returned an invalid token for "${docId}".`);
		}
		return token;
	} catch (e) {
		nextTokenAttemptAt = Date.now() + TOKEN_RETRY_DELAY_MS;
		throw e;
	} finally {
		release();
	}
}
