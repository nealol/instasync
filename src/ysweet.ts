import type RealtimePlugin from "./main";

/** Subset of the y-sweet client token needed to connect (see y-sweet SDK). */
export type ClientToken = {
	url: string;
	baseUrl: string;
	docId: string;
	token?: string;
	authorization?: "full" | "read-only";
};

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
	const token = await plugin.auth.docToken(vaultId, docId);
	if (!token || !token.url) {
		throw new Error(`Realtime: auth server returned an invalid token for "${docId}".`);
	}
	return token;
}
