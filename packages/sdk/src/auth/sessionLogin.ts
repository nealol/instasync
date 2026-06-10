/** Node-only user (session-token) login helpers. */

import { RealtimeClient } from "../client";
import { normalizeBaseUrl } from "../http";
import { openInBrowser, startLoopback } from "./loopback";

export interface BrowserLoginOptions {
	baseUrl: string;
	/**
	 * Fixed loopback port. The server validates the redirect *origin* (port
	 * included) against its `ALLOWED_LOGIN_REDIRECTS` env, so production
	 * setups must allowlist e.g. `http://127.0.0.1:53682` and pass that port
	 * here. Defaults to an ephemeral port (fine for self-origin/mock setups).
	 */
	port?: number;
	/** Injectable for tests; defaults to opening the platform browser. */
	openBrowser?: (url: string) => Promise<void> | void;
	timeoutMs?: number;
}

/**
 * Interactive user login: opens `{baseUrl}/auth/login?redirect={loopback}` in
 * the browser and waits for the server to redirect back with `?token=`.
 *
 * Requires the server to allow the loopback origin (`ALLOWED_LOGIN_REDIRECTS`);
 * otherwise the server responds "login redirect is not allowed" and this
 * throws a descriptive error — fall back to a pasted token and
 * `new RealtimeClient({ baseUrl, token })`.
 */
export async function loginViaBrowser(opts: BrowserLoginOptions): Promise<string> {
	const baseUrl = normalizeBaseUrl(opts.baseUrl);
	const loopback = await startLoopback({ port: opts.port, path: "/login-callback" });
	try {
		const loginUrl = `${baseUrl}/auth/login?redirect=${encodeURIComponent(loopback.url)}`;
		await (opts.openBrowser ?? openInBrowser)(loginUrl);
		const params = await loopback.waitForCallback({ timeoutMs: opts.timeoutMs });
		const token = params.get("token");
		if (!token) {
			throw new Error(
				"login redirect returned no token. If the server rejected the redirect " +
					"('login redirect is not allowed'), add the loopback origin " +
					`(${loopback.origin}) to the server's ALLOWED_LOGIN_REDIRECTS, ` +
					"or use a pasted token with `new RealtimeClient({ baseUrl, token })`.",
			);
		}
		return token;
	} finally {
		await loopback.close();
	}
}

/**
 * Validate a pasted session token by calling `GET /api/me`; returns a ready
 * client. (Get a token by visiting `{baseUrl}/auth/login` in a browser — with
 * no redirect parameter the server renders the token for copy/paste.)
 */
export async function clientFromPastedToken(baseUrl: string, token: string): Promise<RealtimeClient> {
	const client = new RealtimeClient({ baseUrl, token });
	await client.me(); // throws AuthError on a bad/expired token
	return client;
}
