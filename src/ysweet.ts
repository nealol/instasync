import { requestUrl } from "obsidian";

/** Subset of the y-sweet client token needed to connect (see y-sweet SDK). */
export type ClientToken = {
	url: string;
	baseUrl: string;
	docId: string;
	token?: string;
	authorization?: "full" | "read-only";
};

/**
 * Obtains a y-sweet {@link ClientToken} for a document by talking directly to a
 * y-sweet server. This mirrors `getOrCreateDocAndToken` from the y-sweet SDK,
 * but uses Obsidian's `requestUrl` so it works around CORS in the desktop app.
 *
 * The development server (`y-sweet serve`) requires no server token, which is
 * the intended target for this prototype.
 */
export async function getClientToken(serverUrl: string, docId: string): Promise<ClientToken> {
	const base = serverUrl.replace(/\/$/, "");

	// Ensure the document exists. This is idempotent server-side.
	try {
		await requestUrl({
			url: `${base}/doc/new`,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ docId }),
			throw: false,
		});
	} catch (e) {
		// Non-fatal: the doc may already exist, or the server may auto-create on auth.
	}

	const res = await requestUrl({
		url: `${base}/doc/${encodeURIComponent(docId)}/auth`,
		method: "POST",
		contentType: "application/json",
		body: JSON.stringify({}),
		throw: false,
	});

	if (res.status < 200 || res.status >= 300) {
		throw new Error(`y-sweet auth failed for "${docId}": HTTP ${res.status}`);
	}

	const token = res.json as ClientToken;
	if (!token || !token.url) {
		throw new Error(`y-sweet returned an invalid client token for "${docId}"`);
	}
	return token;
}
