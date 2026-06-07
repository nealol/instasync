import { requestUrl } from "obsidian";
import type InstaSyncPlugin from "./main";
import type { ClientToken } from "./ysweet";

/** Identity returned by `GET /api/me`. */
export interface MeResponse {
	userId: string;
	email: string;
	displayName: string;
}

/** Server identity returned by the public `GET /api/server-info`. */
export interface ServerInfoResponse {
	serverId: string;
}

export interface VaultInfo {
	id: string;
	name: string;
	role: "admin" | "member";
	createdBy?: string;
	owner?: boolean;
}

export interface MemberInfo {
	userId: string;
	email: string;
	displayName: string;
	role: "admin" | "member";
	owner?: boolean;
}

export interface RemoteCursorInfo {
	id: string;
	appId: string;
	name: string;
	mcpUrl: string;
	createdAt: number;
}

export interface SearchHit {
	path: string;
	guid: string;
	title: string;
	permalink: string;
	snippet: string;
}

export interface TagCount {
	tag: string;
	count: number;
}

/** Stable permalink for a note, returned by the note-permalinks endpoint. */
export interface PermalinkResponse {
	kind: string;
	url: string;
}

/** Thrown when the server rejects the session; callers should prompt re-login. */
export class AuthError extends Error {}

/**
 * Talks to the InstaSync auth server: SSO login (via an `obsidian://` deep link,
 * with a paste-code fallback), session management, and the vault/sharing/token
 * endpoints. Uses Obsidian's `requestUrl` so it works around desktop CORS.
 */
export class AuthClient {
	private plugin: InstaSyncPlugin;
	/** Resolver for an in-flight login call awaiting the deep link / paste code. */
	private pendingLogin: ((token: string) => Promise<MeResponse>) | null = null;
	/** Rejecter paired with {@link pendingLogin}, so the wait can be cancelled. */
	private pendingReject: ((err: Error) => void) | null = null;
	private pendingTimer: number | null = null;

	constructor(plugin: InstaSyncPlugin) {
		this.plugin = plugin;
	}

	private get baseUrl(): string {
		return normalizeServerUrl(this.plugin.settings.authServerUrl);
	}

	/**
	 * SecretStorage key for the current server's session token. Obsidian's
	 * SecretStorage is shared across local vaults, so the key is namespaced by
	 * server host + the server's stable id (`/api/server-info`) to let one client
	 * hold tokens for multiple servers at once. Falls back to the legacy global
	 * key when the server id isn't known yet (pre-migration installs).
	 */
	private tokenKey(): string {
		const serverId = this.plugin.settings.authServerId;
		if (!serverId) return LEGACY_TOKEN_KEY;
		return sessionTokenKey(this.plugin.settings.authServerUrl, serverId);
	}

	private getToken(): string {
		return this.plugin.app.secretStorage.getSecret(this.tokenKey()) ?? '';
	}

	private setToken(value: string): void {
		this.plugin.app.secretStorage.setSecret(this.tokenKey(), value);
	}

	private deleteToken(): void {
		// SecretStorage has no delete; clear by storing an empty value. Also clear
		// the legacy global key so a stale token can't linger and keep the client
		// looking signed in after logout.
		this.plugin.app.secretStorage.setSecret(this.tokenKey(), "");
		this.plugin.app.secretStorage.setSecret(LEGACY_TOKEN_KEY, "");
	}

	get isLoggedIn(): boolean {
		return !!this.getToken();
	}

	// --- server identity -------------------------------------------------------

	/** Fetch a server's stable id (public endpoint; no session required). */
	serverInfo(baseUrl: string): Promise<ServerInfoResponse> {
		return this.apiAt<ServerInfoResponse>(normalizeServerUrl(baseUrl), "/api/server-info");
	}

	/**
	 * Ensure `authServerId` is known for the current server, fetching it from
	 * `/api/server-info` if needed and migrating any token stored under the legacy
	 * global key into the per-server key. Best-effort: callers may ignore failures
	 * (e.g. offline), in which case the legacy key keeps working.
	 */
	async ensureServerId(): Promise<string> {
		if (this.plugin.settings.authServerId) return this.plugin.settings.authServerId;
		const { serverId } = await this.serverInfo(this.baseUrl);
		this.plugin.settings.authServerId = serverId;
		this.migrateLegacyToken();
		await this.plugin.saveSettings();
		return serverId;
	}

	/** Move a token from the legacy global key to this server's namespaced key. */
	private migrateLegacyToken(): void {
		const legacy = this.plugin.app.secretStorage.getSecret(LEGACY_TOKEN_KEY);
		if (!legacy) return;
		this.plugin.app.secretStorage.setSecret(this.tokenKey(), legacy);
		// SecretStorage has no delete; clear the legacy key by storing empty.
		this.plugin.app.secretStorage.setSecret(LEGACY_TOKEN_KEY, "");
	}

	// --- low-level request -----------------------------------------------------

	private async api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
		return this.apiAt<T>(this.baseUrl, path, this.getToken(), init);
	}

	async apiAt<T>(baseUrl: string, path: string, token?: string, init?: { method?: string; body?: unknown }): Promise<T> {
		const res = await requestUrl({
			url: `${normalizeServerUrl(baseUrl)}${path}`,
			method: init?.method ?? "GET",
			contentType: init?.body !== undefined ? "application/json" : undefined,
			headers: token ? { Authorization: `Bearer ${token}` } : undefined,
			body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
			throw: false,
		});

		if (res.status === 401) {
			if (normalizeServerUrl(baseUrl) === this.baseUrl) await this.clearSession();
			throw new AuthError("Session expired. Please sign in again.");
		}
		if (res.status < 200 || res.status >= 300) {
			const msg = (res.json as { error?: string })?.error ?? `HTTP ${res.status}`;
			throw new Error(msg);
		}
		return res.json as T;
	}

	// --- session ---------------------------------------------------------------

	/** Store a session token, then fetch identity and seed defaults. */
	async setSession(token: string): Promise<MeResponse> {
		// Resolve the server id first so the token lands under the per-server key.
		await this.resolveServerId(this.baseUrl);
		this.setToken(token);
		await this.plugin.saveSettings();

		const me = await this.me();
		await this.applySession(token, me);
		return me;
	}

	async setSessionForServer(baseUrl: string, token: string, me: MeResponse): Promise<void> {
		const normalized = normalizeServerUrl(baseUrl);
		this.plugin.settings.authServerUrl = normalized;
		// Bind the token to this server's stable id before it is written to
		// SecretStorage (which is shared across local vaults).
		await this.resolveServerId(normalized);
		await this.applySession(token, me);
	}

	/** Fetch and store the server's stable id for the given (already-set) server. */
	private async resolveServerId(baseUrl: string): Promise<void> {
		const { serverId } = await this.serverInfo(baseUrl);
		this.plugin.settings.authServerId = serverId;
	}

	private async applySession(token: string, me: MeResponse): Promise<void> {
		this.setToken(token);
		this.plugin.settings.userDisplayName = me.displayName;
		this.plugin.settings.userEmail = me.email;
		// Default the cursor name to the SSO display name on first login.
		if (!this.plugin.settings.clientName) {
			this.plugin.settings.clientName = me.displayName;
		}
		await this.plugin.saveSettings();
	}

	private async clearSession(): Promise<void> {
		this.deleteToken();
		this.plugin.settings.userDisplayName = "";
		this.plugin.settings.userEmail = "";
		await this.plugin.saveSettings();
	}

	destroy(): void {
		if (this.pendingTimer !== null) {
			window.clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
		}
		this.cancelPendingLogin("Sign-in cancelled: plugin unloaded.");
	}

	/** Log out: drop the session and the active vault binding. */
	async logout(): Promise<void> {
		try {
			if (this.getToken()) {
				await this.api("/api/logout", { method: "POST", body: {} });
			}
		} catch (e) {
			console.warn("[InstaSync] server logout failed", e);
		}
		this.plugin.settings.activeVaultId = "";
		await this.clearSession();
	}

	me(): Promise<MeResponse> {
		return this.api<MeResponse>("/api/me");
	}

	// --- login flow ------------------------------------------------------------

	/**
	 * Open the browser to the SSO login page and resolve once the auth server
	 * redirects back to `obsidian://instasync-auth?token=…`. The settings tab also
	 * offers a paste-code fallback that calls {@link setSession} directly.
	 */
	async login(): Promise<MeResponse> {
		const { token, me } = await this.authenticateAt(this.baseUrl);
		await this.applySession(token, me);
		return me;
	}

	async loginToServer(baseUrl: string): Promise<MeResponse> {
		const normalized = normalizeServerUrl(baseUrl);
		const { token, me } = await this.authenticateAt(normalized);
		await this.setSessionForServer(normalized, token, me);
		return me;
	}

	authenticateAt(baseUrl: string): Promise<{ token: string; me: MeResponse }> {
		const normalized = normalizeServerUrl(baseUrl);
		// Record which server this SSO attempt targets. Pointing it at a different
		// server cancels any earlier in-flight login (see beginSetupFor). Must run
		// before we install the new resolver below so we don't cancel ourselves.
		this.beginSetupFor(normalized);
		const redirect = encodeURIComponent("obsidian://instasync-auth");
		window.open(`${normalized}/auth/login?redirect=${redirect}`);
		return new Promise<{ token: string; me: MeResponse }>((resolve, reject) => {
			this.pendingReject = reject;
			this.pendingLogin = (token: string) => {
				this.pendingLogin = null;
				this.pendingReject = null;
				if (this.pendingTimer !== null) {
					window.clearTimeout(this.pendingTimer);
					this.pendingTimer = null;
				}
				const validation = this.apiAt<MeResponse>(normalized, "/api/me", token)
					.then(async (me) => {
						await this.setSessionForServer(normalized, token, me);
						resolve({ token, me });
						return me;
					});
				validation.catch(reject);
				return validation;
			};
			// Abandon the wait after 5 minutes so the promise can't leak forever.
			// Guard on identity so a stale timer can't reject a newer attempt.
			this.pendingTimer = window.setTimeout(() => {
				if (this.pendingReject === reject) {
					this.pendingLogin = null;
					this.pendingReject = null;
					this.pendingTimer = null;
					reject(new Error("Login timed out."));
				}
			}, 5 * 60 * 1000);
		});
	}

	/**
	 * Record the server an SSO attempt targets in the dedicated
	 * `pendingSetupServerUrl` setting (used for nothing else). If that value
	 * changes, any in-flight SSO login is cancelled — switching servers mid-setup
	 * must not let a stale login resolve against the wrong server.
	 */
	private beginSetupFor(baseUrl: string): void {
		if (this.plugin.settings.pendingSetupServerUrl !== baseUrl) {
			this.cancelPendingLogin("Sign-in cancelled: setup server changed.");
			this.plugin.settings.pendingSetupServerUrl = baseUrl;
			void this.plugin.saveSettings();
		}
	}

	/** Reject and clear any in-flight SSO login wait. */
	private cancelPendingLogin(reason: string): void {
		const reject = this.pendingReject;
		this.pendingLogin = null;
		this.pendingReject = null;
		if (this.pendingTimer !== null) {
			window.clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
		}
		reject?.(new Error(reason));
	}

	/** Called by the registered protocol handler in main.ts. */
	handleProtocol(params: Record<string, string>): Promise<MeResponse | void> {
		const token = params.token;
		if (!token) return Promise.resolve();
		return this.completeWithToken(token);
	}

	/**
	 * Paste-code fallback for when the `obsidian://` deep link doesn't fire:
	 * feed the token shown in the browser straight into the pending login.
	 */
	submitPastedCode(token: string): void {
		const trimmed = token.trim();
		if (!trimmed) return;
		void this.completeWithToken(trimmed);
	}

	private completeWithToken(token: string): Promise<MeResponse | void> {
		if (this.pendingLogin) {
			return this.pendingLogin(token);
		} else {
			// No awaiting promise (e.g. app restarted between open and callback).
			return this.setSession(token);
		}
	}

	// --- vaults / sharing ------------------------------------------------------

	listVaults(): Promise<VaultInfo[]> {
		return this.api<VaultInfo[]>("/api/vaults");
	}

	listVaultsAt(baseUrl: string, token: string): Promise<VaultInfo[]> {
		return this.apiAt<VaultInfo[]>(baseUrl, "/api/vaults", token);
	}

	createVault(name: string): Promise<VaultInfo> {
		return this.api<VaultInfo>("/api/vaults", { method: "POST", body: { name } });
	}

	createInvite(vaultId: string, role?: "admin" | "member"): Promise<{ code: string }> {
		return this.api<{ code: string }>(`/api/vaults/${vaultId}/invites`, {
			method: "POST",
			body: { role },
		});
	}

	redeemInvite(code: string): Promise<{ vaultId: string; name: string }> {
		return this.api<{ vaultId: string; name: string }>("/api/invites/redeem", {
			method: "POST",
			body: { code },
		});
	}

	listMembers(vaultId: string): Promise<MemberInfo[]> {
		return this.api<MemberInfo[]>(`/api/vaults/${vaultId}/members`);
	}

	promoteMember(vaultId: string, userId: string): Promise<MemberInfo> {
		return this.api<MemberInfo>(`/api/vaults/${vaultId}/members/${userId}/promote`, {
			method: "POST",
			body: {},
		});
	}

	async removeMember(vaultId: string, userId: string): Promise<void> {
		await this.api(`/api/vaults/${vaultId}/members/${userId}`, { method: "DELETE" });
	}

	listCursors(vaultId: string): Promise<RemoteCursorInfo[]> {
		return this.api<RemoteCursorInfo[]>(`/api/vaults/${vaultId}/cursors`);
	}

	createCursor(vaultId: string, name: string): Promise<RemoteCursorInfo & { secretToken: string }> {
		return this.api<RemoteCursorInfo & { secretToken: string }>(`/api/vaults/${vaultId}/cursors`, {
			method: "POST",
			body: { name },
		});
	}

	renameCursor(vaultId: string, cursorId: string, name: string): Promise<RemoteCursorInfo> {
		return this.api<RemoteCursorInfo>(`/api/vaults/${vaultId}/cursors/${cursorId}`, {
			method: "POST",
			body: { name },
		});
	}

	regenerateCursorToken(vaultId: string, cursorId: string): Promise<{ secretToken: string }> {
		return this.api<{ secretToken: string }>(`/api/vaults/${vaultId}/cursors/${cursorId}/token`, {
			method: "POST",
			body: {},
		});
	}

	async deleteCursor(vaultId: string, cursorId: string): Promise<void> {
		await this.api(`/api/vaults/${vaultId}/cursors/${cursorId}`, { method: "DELETE" });
	}

	/** Resolve a stable, shareable permalink (`…/n/{guid}`) for a note by path. */
	notePermalink(vaultId: string, path: string): Promise<PermalinkResponse> {
		const encoded = path.split("/").map(encodeURIComponent).join("/");
		return this.api<PermalinkResponse>(
			`/api/vaults/${vaultId}/note-permalinks/${encoded}`,
			{ method: "POST", body: {} },
		);
	}

	search(vaultId: string, q: string, limit?: number): Promise<SearchHit[]> {
		const params = new URLSearchParams({ q });
		if (limit !== undefined) params.set("limit", String(limit));
		return this.api<SearchHit[]>(`/api/vaults/${vaultId}/search?${params.toString()}`);
	}

	listTags(vaultId: string): Promise<TagCount[]> {
		return this.api<TagCount[]>(`/api/vaults/${vaultId}/tags`);
	}

	backlinks(vaultId: string, path: string): Promise<SearchHit[]> {
		const encoded = path.split("/").map(encodeURIComponent).join("/");
		return this.api<SearchHit[]>(`/api/vaults/${vaultId}/backlinks/${encoded}`);
	}

	/** Best-effort registry update so the server can resolve doc → path for ACLs. */
	async registerFile(vaultId: string, guid: string, path: string): Promise<void> {
		try {
			await this.api(`/api/vaults/${vaultId}/files`, {
				method: "POST",
				body: { guid, path },
			});
		} catch (e) {
			console.warn("[InstaSync] file registry update failed", e);
		}
	}

	/** Mint a y-sweet client token for a (namespaced) doc id in the active vault. */
	docToken(vaultId: string, docId: string): Promise<ClientToken> {
		return this.api<ClientToken>("/api/doc-token", {
			method: "POST",
			body: { vaultId, docId },
		});
	}

	// --- binary blob store -----------------------------------------------------
	//
	// Binary file contents are stored content-addressed by sha256 hash, separate
	// from the JSON API (these carry raw bytes, not JSON). All three are vault
	// scoped: the server requires membership of `vaultId`.

	private blobUrl(vaultId: string, hash: string): string {
		return `${this.baseUrl}/api/vaults/${vaultId}/blobs/${hash}`;
	}

	private get authHeaders(): Record<string, string> {
		const token = this.getToken();
		return token ? { Authorization: `Bearer ${token}` } : {};
	}

	/** True if the server already holds the blob (lets callers skip re-upload). */
	async blobExists(vaultId: string, hash: string): Promise<boolean> {
		const res = await requestUrl({
			url: this.blobUrl(vaultId, hash),
			method: "HEAD",
			headers: this.authHeaders,
			throw: false,
		});
		if (res.status === 401) {
			await this.clearSession();
			throw new AuthError("Session expired. Please sign in again.");
		}
		return res.status >= 200 && res.status < 300;
	}

	/** Download blob bytes by hash. */
	async getBlob(vaultId: string, hash: string): Promise<ArrayBuffer> {
		const res = await requestUrl({
			url: this.blobUrl(vaultId, hash),
			method: "GET",
			headers: this.authHeaders,
			throw: false,
		});
		if (res.status === 401) {
			await this.clearSession();
			throw new AuthError("Session expired. Please sign in again.");
		}
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`blob download failed: ${blobErrorMessage(res)}`);
		}
		return res.arrayBuffer;
	}

	/** Upload blob bytes; idempotent and content-verified server-side. */
	async putBlob(vaultId: string, hash: string, data: ArrayBuffer): Promise<void> {
		const res = await requestUrl({
			url: this.blobUrl(vaultId, hash),
			method: "PUT",
			headers: this.authHeaders,
			contentType: "application/octet-stream",
			body: data,
			throw: false,
		});
		if (res.status === 401) {
			await this.clearSession();
			throw new AuthError("Session expired. Please sign in again.");
		}
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`blob upload failed: ${blobErrorMessage(res)}`);
		}
	}
}

/**
 * Build an error message from a failed blob response without touching the
 * response's lazy `.json` getter, which throws on an empty body (e.g. axum's
 * default 404, which has no body — the symptom when the server lacks the blob
 * routes). Falls back to the bare status code.
 */
function blobErrorMessage(res: { status: number; text?: string }): string {
	const text = (res.text ?? "").trim();
	if (text) {
		try {
			const parsed = JSON.parse(text) as { error?: string };
			if (parsed?.error) return parsed.error;
		} catch {
			return `HTTP ${res.status}: ${text.slice(0, 200)}`;
		}
	}
	return `HTTP ${res.status}`;
}

/** Legacy, un-namespaced SecretStorage key (single global session token). */
const LEGACY_TOKEN_KEY = "instasync-session-token";

/**
 * SecretStorage key for a server's session token, namespaced by host + the
 * server's stable id. The host keeps keys human-recognizable; the id guarantees
 * uniqueness even if two servers share a host (e.g. behind different paths) or a
 * host is reused. SecretStorage is shared across local Obsidian vaults, so this
 * lets one client hold independent tokens for multiple servers.
 *
 * Obsidian requires secret ids to be lowercase alphanumeric with optional
 * dashes, so the host is sanitized (e.g. `127.0.0.1:8081` -> `127-0-0-1-8081`)
 * and dashes are used as separators. The server id alone guarantees uniqueness.
 */
function sessionTokenKey(serverUrl: string, serverId: string): string {
	let host: string;
	try {
		host = new URL(serverUrl).host;
	} catch {
		host = serverUrl;
	}
	const safeHost = host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	const safeId = serverId.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
	return `${LEGACY_TOKEN_KEY}-${safeHost}-${safeId}`;
}

export function normalizeServerUrl(url: string): string {
	const trimmed = url.trim().replace(/\/+$/, "");
	if (!trimmed) throw new Error("Enter a server URL.");
	const parsed = new URL(trimmed);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Server URL must start with http:// or https://.");
	}
	return parsed.toString().replace(/\/$/, "");
}
