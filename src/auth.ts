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
}

export interface MemberInfo {
	userId: string;
	email: string;
	displayName: string;
	role: "admin" | "member";
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
	/** Resolver for an in-flight {@link login} call awaiting the deep link. */
	private pendingLogin: ((token: string) => void) | null = null;

	constructor(plugin: InstaSyncPlugin) {
		this.plugin = plugin;
	}

	private get baseUrl(): string {
		return this.plugin.settings.authServerUrl.replace(/\/$/, "");
	}

	get isLoggedIn(): boolean {
		return !!this.plugin.settings.sessionToken;
	}

	// --- low-level request -----------------------------------------------------

	private async api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
		const token = this.plugin.settings.sessionToken;
		const res = await requestUrl({
			url: `${this.baseUrl}${path}`,
			method: init?.method ?? "GET",
			contentType: init?.body !== undefined ? "application/json" : undefined,
			headers: token ? { Authorization: `Bearer ${token}` } : undefined,
			body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
			throw: false,
		});

		if (res.status === 401) {
			await this.clearSession();
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
		this.plugin.settings.userDisplayName = me.displayName;
		this.plugin.settings.userEmail = me.email;
		// Default the cursor name to the SSO display name on first login.
		if (!this.plugin.settings.clientName) {
			this.plugin.settings.clientName = me.displayName;
		}
		await this.plugin.saveSettings();
		return me;
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
	login(): Promise<MeResponse> {
		const redirect = encodeURIComponent("obsidian://instasync-auth");
		window.open(`${this.baseUrl}/auth/login?redirect=${redirect}`);
		return new Promise<MeResponse>((resolve, reject) => {
			this.pendingLogin = (token: string) => {
				this.pendingLogin = null;
				this.setSession(token).then(resolve, reject);
			};
			// Abandon the wait after 5 minutes so the promise can't leak forever.
			window.setTimeout(() => {
				if (this.pendingLogin) {
					this.pendingLogin = null;
					reject(new Error("Login timed out."));
				}
			}, 5 * 60 * 1000);
		});
	}

	/** Called by the registered protocol handler in main.ts. */
	handleProtocol(params: Record<string, string>): void {
		const token = params.token;
		if (!token) return;
		if (this.pendingLogin) {
			this.pendingLogin(token);
		} else {
			// Login completed without an awaiting promise (e.g. app restarted).
			void this.setSession(token);
		}
	}

	// --- vaults / sharing ------------------------------------------------------

	listVaults(): Promise<VaultInfo[]> {
		return this.api<VaultInfo[]>("/api/vaults");
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
