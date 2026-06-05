import { requestUrl } from "obsidian";
import type InstaSyncPlugin from "./main";
import type { ClientToken } from "./ysweet";

/** Identity returned by `GET /api/me`. */
export interface MeResponse {
	userId: string;
	email: string;
	displayName: string;
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
	private pendingLogin: ((token: string) => void) | null = null;
	/** Rejecter paired with {@link pendingLogin}, so the wait can be cancelled. */
	private pendingReject: ((err: Error) => void) | null = null;

	constructor(plugin: InstaSyncPlugin) {
		this.plugin = plugin;
	}

	private get baseUrl(): string {
		return normalizeServerUrl(this.plugin.settings.authServerUrl);
	}

	get isLoggedIn(): boolean {
		return !!this.plugin.settings.sessionToken;
	}

	// --- low-level request -----------------------------------------------------

	private async api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
		const token = this.plugin.settings.sessionToken;
		return this.apiAt<T>(this.baseUrl, path, token, init);
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
		this.plugin.settings.sessionToken = token;
		await this.plugin.saveSettings();

		const me = await this.me();
		await this.applySession(token, me);
		return me;
	}

	async setSessionForServer(baseUrl: string, token: string, me: MeResponse): Promise<void> {
		this.plugin.settings.authServerUrl = normalizeServerUrl(baseUrl);
		await this.applySession(token, me);
	}

	private async applySession(token: string, me: MeResponse): Promise<void> {
		this.plugin.settings.sessionToken = token;
		this.plugin.settings.userDisplayName = me.displayName;
		this.plugin.settings.userEmail = me.email;
		// Default the cursor name to the SSO display name on first login.
		if (!this.plugin.settings.clientName) {
			this.plugin.settings.clientName = me.displayName;
		}
		await this.plugin.saveSettings();
	}

	private async clearSession(): Promise<void> {
		this.plugin.settings.sessionToken = "";
		this.plugin.settings.userDisplayName = "";
		this.plugin.settings.userEmail = "";
		await this.plugin.saveSettings();
	}

	/** Log out: drop the session and the active vault binding. */
	async logout(): Promise<void> {
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
				this.apiAt<MeResponse>(normalized, "/api/me", token)
					.then((me) => resolve({ token, me }))
					.catch(reject);
			};
			// Abandon the wait after 5 minutes so the promise can't leak forever.
			// Guard on identity so a stale timer can't reject a newer attempt.
			window.setTimeout(() => {
				if (this.pendingReject === reject) {
					this.pendingLogin = null;
					this.pendingReject = null;
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
		reject?.(new Error(reason));
	}

	/** Called by the registered protocol handler in main.ts. */
	handleProtocol(params: Record<string, string>): void {
		const token = params.token;
		if (!token) return;
		this.completeWithToken(token);
	}

	/**
	 * Paste-code fallback for when the `obsidian://` deep link doesn't fire:
	 * feed the token shown in the browser straight into the pending login.
	 */
	submitPastedCode(token: string): void {
		const trimmed = token.trim();
		if (!trimmed) return;
		this.completeWithToken(trimmed);
	}

	private completeWithToken(token: string): void {
		if (this.pendingLogin) {
			this.pendingLogin(token);
		} else {
			// No awaiting promise (e.g. app restarted between open and callback).
			void this.setSession(token);
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
