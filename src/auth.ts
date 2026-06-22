import { requestUrl } from "obsidian";
import type RealtimePlugin from "./main";
import type { ClientToken } from "./ysweet";
import { checkServerCaps, CompatibilityError } from "./caps";

/** Identity returned by `GET /api/me`. */
export interface MeResponse {
  userId: string;
  email: string;
  gitEmail?: string;
  displayName: string;
}

export interface KnownSession extends MeResponse {
  serverUrl: string;
  serverId: string;
  tokenKey: string;
}

/** Server identity returned by the public `GET /api/server-info`. */
export interface ServerInfoResponse {
  serverId: string;
  /** Server release semver (operator-facing; not used for gating). */
  version?: string;
  /** Named capability versions per surface. Required by this plugin for compatibility gating. */
  caps?: Record<string, string>;
  /** Cap names the client must understand. Optional; empty in v1. */
  requiredCaps?: string[];
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
  /** Manifest id of the managing plugin; absent for admin-created cursors. */
  pluginId?: string | null;
}

export interface PluginCursorGrant {
  id: string;
  appId: string;
  name: string;
  vaultId: string;
  pluginId: string;
  mcpUrl: string;
  streamUrl: string;
  secretToken: string;
  expiresAt: number;
}

export interface CursorAuditEntry {
  id: string;
  createdAt: number;
  operation: string;
  path: string;
  toPath?: string | null;
  beforeContent?: string | null;
  afterContent?: string | null;
  details?: Record<string, unknown> | null;
  undoneAt?: number | null;
}

export interface CursorAuditPage {
  entries: CursorAuditEntry[];
  hasMore: boolean;
}

export interface GitBackupConfig {
  configured: boolean;
  remoteUrl?: string;
  authMethod?: "ssh" | "https";
  branch?: string;
  sshPublicKey?: string;
  hasHttpsToken: boolean;
  enabled: boolean;
  lastPushAt?: number;
  lastPushError?: string;
}

export interface PutGitBackupBody {
  remoteUrl: string;
  authMethod: "ssh" | "https";
  branch?: string;
  httpsToken?: string;
  regenerateKey?: boolean;
  enabled: boolean;
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

/** A public read-only share link for a note (rendered at `/view/{id}`). */
export interface PublicShareResponse {
  id: string;
  url: string;
  path: string;
  guid: string;
  createdAt: number;
}

/** Per-vault storage breakdown, from `GET /api/vaults/{id}/storage`. */
export interface StorageUsage {
  blobsCurrentBytes: number;
  blobsPreviousBytes: number;
  currentBlobCount: number;
  previousBlobCount: number;
  /** null when the y-sweet store path is not configured / readable server-side. */
  plainVaultBytes: number | null;
}

/** Result of an orphaned-blob cleanup. */
export interface GcBlobsResult {
  removed: number;
  freedBytes: number;
}

/** Thrown when the server rejects the session; callers should prompt re-login. */
export class AuthError extends Error {}

/**
 * Validate a self-settable git author email. Mirrors the server-side
 * `validate_git_email` (server/src/routes.rs): the value flows unescaped into
 * `Name <email>` passed to `git commit --author` and into `Co-authored-by`
 * trailers, so it must not contain control chars, whitespace, or angle
 * brackets, and must have a basic email shape. Returns a human-readable error
 * message, or `null` when the value is valid — including the empty string,
 * which clears the field (falling back to the login email).
 */
export function validateGitEmail(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > 254) return "Git author email is too long.";
  if (/[\x00-\x1f\x7f<>\s]/.test(trimmed)) {
    return "Git author email must not contain spaces, angle brackets, or line breaks.";
  }
  const at = trimmed.indexOf("@");
  if (at < 0 || at !== trimmed.lastIndexOf("@")) {
    return "Enter a valid email address.";
  }
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (local === "" || domain === "" || !domain.includes(".")) {
    return "Enter a valid email address.";
  }
  return null;
}

/**
 * Talks to the Realtime auth server: SSO login (via an `obsidian://` deep link,
 * with a paste-code fallback), session management, and the vault/sharing/token
 * endpoints. Uses Obsidian's `requestUrl` so it works around desktop CORS.
 */
export class AuthClient {
  private plugin: RealtimePlugin;
  /** Resolver for an in-flight login call awaiting the deep link / paste code. */
  private pendingLogin: ((token: string) => Promise<MeResponse>) | null = null;
  /** Rejecter paired with {@link pendingLogin}, so the wait can be cancelled. */
  private pendingReject: ((err: Error) => void) | null = null;
  private pendingTimer: number | null = null;

  constructor(plugin: RealtimePlugin) {
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
  private tokenKey(userId = this.plugin.settings.userId): string {
    const serverId = this.plugin.settings.authServerId;
    if (!serverId) return LEGACY_TOKEN_KEY;
    if (!userId) return serverSessionTokenKey(this.plugin.settings.authServerUrl, serverId);
    return sessionTokenKey(this.plugin.settings.authServerUrl, serverId, userId);
  }

  private getToken(): string {
    return (
      this.plugin.app.secretStorage.getSecret(this.tokenKey()) ??
      this.plugin.app.secretStorage.getSecret(this.tokenKey("")) ??
      ""
    );
  }

  private setToken(value: string, userId = this.plugin.settings.userId): void {
    this.plugin.app.secretStorage.setSecret(this.tokenKey(userId), value);
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

  /**
   * Fetch a server's stable id, release version, and advertised caps (public
   * endpoint; no session required). Raw fetch with no compatibility check —
   * kept private so all callers go through {@link serverInfoChecked} and cannot
   * bypass cap gating.
   */
  private async rawServerInfo(baseUrl: string): Promise<ServerInfoResponse> {
    return this.apiAt<ServerInfoResponse>(normalizeServerUrl(baseUrl), "/api/server-info");
  }

  /**
   * Fetch `/api/server-info` and enforce capability compatibility. On a cap
   * mismatch or missing caps, sets `plugin.lastCompatibilityError` and throws
   * {@link CompatibilityError}. On success, clears `plugin.lastCompatibilityError`
   * and returns the full response so callers can read `serverId` as before.
   *
   * Network/offline errors propagate as normal exceptions (not
   * `CompatibilityError`); callers tolerate them as today.
   */
  async serverInfoChecked(baseUrl: string): Promise<ServerInfoResponse> {
    const info = await this.rawServerInfo(baseUrl);
    const result = checkServerCaps(info.caps, info.requiredCaps);
    if (result.ok) {
      this.plugin.lastCompatibilityError = null;
      return info;
    }
    this.plugin.lastCompatibilityError = {
      reason: result.reason,
      detail: result.detail,
      serverVersion: info.version,
    };
    throw new CompatibilityError(result.reason, result.detail, info.version);
  }

  /**
   * Ensure `authServerId` is known for the current server, fetching it from
   * `/api/server-info` if needed and migrating any token stored under the legacy
   * global key into the per-server key. Best-effort: callers may ignore failures
   * (e.g. offline), in which case the legacy key keeps working.
   */
  async ensureServerId(): Promise<string> {
    const existing = this.plugin.settings.authServerId;
    if (existing) {
      try {
        const { serverId } = await this.serverInfoChecked(this.baseUrl);
        if (serverId !== existing) {
          this.plugin.settings.authServerId = serverId;
          await this.plugin.saveSettings();
        }
        return serverId;
      } catch (e) {
        // Existing installs should still start while offline, but a cap failure
        // means the server explicitly advertised an incompatible protocol.
        if (e instanceof CompatibilityError) throw e;
        return existing;
      }
    }
    const { serverId } = await this.serverInfoChecked(this.baseUrl);
    this.plugin.settings.authServerId = serverId;
    await this.migrateLegacyToken();
    await this.plugin.saveSettings();
    return serverId;
  }

  /** Move a token from the legacy global key to this server's namespaced key. */
  private async migrateLegacyToken(): Promise<void> {
    const legacy = this.plugin.app.secretStorage.getSecret(LEGACY_TOKEN_KEY);
    if (!legacy) return;
    let me: MeResponse | null = null;
    try {
      me = await this.apiAt<MeResponse>(this.baseUrl, "/api/me", legacy);
    } catch {
      // Keep the old per-server migration path if the token can't be validated.
    }
    this.plugin.app.secretStorage.setSecret(
      me ? this.tokenKey(me.userId) : this.tokenKey(""),
      legacy,
    );
    if (me) this.rememberSession(me, this.tokenKey(me.userId));
    // SecretStorage has no delete; clear the legacy key by storing empty.
    this.plugin.app.secretStorage.setSecret(LEGACY_TOKEN_KEY, "");
  }

  // --- low-level request -----------------------------------------------------

  private async api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    return this.apiAt<T>(this.baseUrl, path, this.getToken(), init);
  }

  async apiAt<T>(
    baseUrl: string,
    path: string,
    token?: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
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
    const { serverId } = await this.serverInfoChecked(baseUrl);
    this.plugin.settings.authServerId = serverId;
  }

  private async applySession(token: string, me: MeResponse): Promise<void> {
    this.plugin.settings.userId = me.userId;
    this.setToken(token, me.userId);
    this.rememberSession(me, this.tokenKey(me.userId));
    this.plugin.settings.userDisplayName = me.displayName;
    this.plugin.settings.userEmail = me.email;
    this.plugin.settings.gitEmail = me.gitEmail ?? "";
    // Default the cursor name to the SSO display name on first login.
    if (!this.plugin.settings.clientName) {
      this.plugin.settings.clientName = me.displayName;
    }
    await this.plugin.saveSettings();
  }

  private async clearSession(): Promise<void> {
    this.deleteToken();
    this.plugin.settings.userId = "";
    this.plugin.settings.userDisplayName = "";
    this.plugin.settings.userEmail = "";
    this.plugin.settings.gitEmail = "";
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
      console.warn("[Realtime] server logout failed", e);
    }
    this.plugin.settings.activeVaultId = "";
    await this.clearSession();
  }

  me(): Promise<MeResponse> {
    return this.api<MeResponse>("/api/me");
  }

  async updateMe(body: { gitEmail?: string }): Promise<MeResponse> {
    const me = await this.api<MeResponse>("/api/me", { method: "PATCH", body });
    this.plugin.settings.gitEmail = me.gitEmail ?? "";
    await this.plugin.saveSettings();
    return me;
  }

  // --- login flow ------------------------------------------------------------

  /**
   * Open the browser to the SSO login page and resolve once the auth server
   * redirects back to `obsidian://realtime-auth?token=…`. The settings tab also
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

  async validSessionsForServer(baseUrl: string): Promise<KnownSession[]> {
    const normalized = normalizeServerUrl(baseUrl);
    const { serverId } = await this.serverInfoChecked(normalized);
    let sessions = this.knownSessions().filter((session) => {
      return (
        session.serverUrl === normalized &&
        session.serverId === serverId &&
        !!this.plugin.app.secretStorage.getSecret(session.tokenKey)
      );
    });
    const oldServerKey = serverSessionTokenKey(normalized, serverId);
    if (
      this.plugin.app.secretStorage.getSecret(oldServerKey) &&
      !sessions.some((session) => session.tokenKey === oldServerKey)
    ) {
      sessions = [
        ...sessions,
        {
          serverUrl: normalized,
          serverId,
          userId: "",
          email: "",
          displayName: "",
          tokenKey: oldServerKey,
        },
      ];
    }
    const valid: KnownSession[] = [];
    for (const session of sessions) {
      const token = this.plugin.app.secretStorage.getSecret(session.tokenKey);
      if (!token) continue;
      try {
        const me = await this.apiAt<MeResponse>(normalized, "/api/me", token);
        const updated = {
          ...session,
          ...me,
          serverUrl: normalized,
          serverId,
          tokenKey: session.tokenKey,
        };
        valid.push(updated);
        this.rememberSession(updated, session.tokenKey);
      } catch {
        this.forgetSession(session.tokenKey);
      }
    }
    return valid;
  }

  async useKnownSession(session: KnownSession): Promise<MeResponse> {
    const token = this.plugin.app.secretStorage.getSecret(session.tokenKey);
    if (!token) throw new AuthError("Saved session not found. Please sign in again.");
    // Verify compatibility before trusting the saved session's server. A
    // server upgrade that broke a cap should not let an old session silently
    // proceed against an incompatible server.
    await this.serverInfoChecked(session.serverUrl);
    this.plugin.settings.authServerUrl = session.serverUrl;
    this.plugin.settings.authServerId = session.serverId;
    const me = await this.apiAt<MeResponse>(session.serverUrl, "/api/me", token);
    await this.applySession(token, me);
    return me;
  }

  async authenticateAt(baseUrl: string): Promise<{ token: string; me: MeResponse }> {
    const normalized = normalizeServerUrl(baseUrl);
    // Verify compatibility before opening the SSO browser flow — a cap
    // mismatch should hard-block before the user is sent to the browser.
    await this.serverInfoChecked(normalized);
    // Record which server this SSO attempt targets. Pointing it at a different
    // server cancels any earlier in-flight login (see beginSetupFor). Must run
    // before we install the new resolver below so we don't cancel ourselves.
    this.beginSetupFor(normalized);
    const redirect = encodeURIComponent("obsidian://realtime-auth");
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
        const validation = this.apiAt<MeResponse>(normalized, "/api/me", token).then(async (me) => {
          await this.setSessionForServer(normalized, token, me);
          resolve({ token, me });
          return me;
        });
        validation.catch(reject);
        return validation;
      };
      // Abandon the wait after 5 minutes so the promise can't leak forever.
      // Guard on identity so a stale timer can't reject a newer attempt.
      this.pendingTimer = window.setTimeout(
        () => {
          if (this.pendingReject === reject) {
            this.pendingLogin = null;
            this.pendingReject = null;
            this.pendingTimer = null;
            reject(new Error("Login timed out."));
          }
        },
        5 * 60 * 1000,
      );
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

  private rememberSession(me: MeResponse, tokenKey: string): void {
    const session: KnownSession = {
      serverUrl: this.baseUrl,
      serverId: this.plugin.settings.authServerId,
      userId: me.userId,
      email: me.email,
      gitEmail: me.gitEmail,
      displayName: me.displayName,
      tokenKey,
    };
    this.saveKnownSessions([
      session,
      ...this.knownSessions().filter((existing) => existing.tokenKey !== tokenKey),
    ]);
  }

  private forgetSession(tokenKey: string): void {
    this.saveKnownSessions(this.knownSessions().filter((session) => session.tokenKey !== tokenKey));
  }

  private knownSessions(): KnownSession[] {
    try {
      const raw = window.localStorage.getItem(KNOWN_SESSIONS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((session): session is KnownSession => {
        return (
          !!session &&
          typeof session === "object" &&
          typeof session.serverUrl === "string" &&
          typeof session.serverId === "string" &&
          typeof session.userId === "string" &&
          typeof session.email === "string" &&
          typeof session.displayName === "string" &&
          typeof session.tokenKey === "string"
        );
      });
    } catch {
      return [];
    }
  }

  private saveKnownSessions(sessions: KnownSession[]): void {
    try {
      window.localStorage.setItem(KNOWN_SESSIONS_KEY, JSON.stringify(sessions));
    } catch {
      // Token discovery is an enhancement; auth still works without the index.
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

  /** Get-or-create the plugin-managed cursor for (vault, plugin) and mint a fresh token. */
  acquirePluginCursor(
    vaultId: string,
    pluginId: string,
    name?: string,
  ): Promise<PluginCursorGrant> {
    return this.api<PluginCursorGrant>(`/api/vaults/${vaultId}/cursors/plugin`, {
      method: "POST",
      body: { pluginId, name },
    });
  }

  listCursorAudit(
    vaultId: string,
    cursorId: string,
    before?: number,
    limit?: number,
  ): Promise<CursorAuditPage> {
    const params = new URLSearchParams();
    if (before !== undefined) params.set("before", String(before));
    if (limit !== undefined) params.set("limit", String(limit));
    const query = params.size ? `?${params.toString()}` : "";
    return this.api<CursorAuditPage>(`/api/vaults/${vaultId}/cursors/${cursorId}/audit${query}`);
  }

  async undoCursorAudit(
    vaultId: string,
    cursorId: string,
    entryId: string,
    force = false,
  ): Promise<void> {
    await this.api(`/api/vaults/${vaultId}/cursors/${cursorId}/audit/${entryId}/undo`, {
      method: "POST",
      body: { force },
    });
  }

  getGitBackup(vaultId: string): Promise<GitBackupConfig> {
    return this.api<GitBackupConfig>(`/api/vaults/${vaultId}/backup`);
  }

  putGitBackup(vaultId: string, body: PutGitBackupBody): Promise<GitBackupConfig> {
    return this.api<GitBackupConfig>(`/api/vaults/${vaultId}/backup`, {
      method: "PUT",
      body,
    });
  }

  async deleteGitBackup(vaultId: string): Promise<void> {
    await this.api(`/api/vaults/${vaultId}/backup`, { method: "DELETE" });
  }

  testGitBackup(vaultId: string): Promise<{ ok: boolean; error?: string }> {
    return this.api<{ ok: boolean; error?: string }>(`/api/vaults/${vaultId}/backup/test`, {
      method: "POST",
      body: {},
    });
  }

  /** Resolve a stable, shareable permalink (`…/n/{guid}`) for a note by path. */
  notePermalink(vaultId: string, path: string): Promise<PermalinkResponse> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return this.api<PermalinkResponse>(`/api/vaults/${vaultId}/note-permalinks/${encoded}`, {
      method: "POST",
      body: {},
    });
  }

  /**
   * Create (or return the existing) public read-only share link for a note.
   * Idempotent server-side; the returned `url` points at `/view/{id}`.
   */
  createPublicShare(vaultId: string, path: string): Promise<PublicShareResponse> {
    return this.api<PublicShareResponse>(`/api/vaults/${vaultId}/shares`, {
      method: "POST",
      body: { path },
    });
  }

  /** Stop publicly sharing a note. Rejects with a 404 error if not shared. */
  async deletePublicShare(vaultId: string, path: string): Promise<void> {
    const params = new URLSearchParams({ path });
    await this.api(`/api/vaults/${vaultId}/shares?${params.toString()}`, { method: "DELETE" });
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
      console.warn("[Realtime] file registry update failed", e);
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

  // --- storage management ----------------------------------------------------

  /** Per-vault storage breakdown (admin only). */
  getStorageUsage(vaultId: string): Promise<StorageUsage> {
    return this.api<StorageUsage>(`/api/vaults/${vaultId}/storage`);
  }

  /** Delete orphaned ("previous") blobs, optionally only those ≥ `minBytes`. */
  gcBlobs(vaultId: string, minBytes?: number): Promise<GcBlobsResult> {
    return this.api<GcBlobsResult>(`/api/vaults/${vaultId}/storage/gc-blobs`, {
      method: "POST",
      body: minBytes !== undefined ? { minBytes } : {},
    });
  }

  /** Reclaim a single orphaned blob (no-op server-side if still referenced). */
  async deleteBlob(vaultId: string, hash: string): Promise<void> {
    await this.api(`/api/vaults/${vaultId}/blobs/${hash}`, { method: "DELETE" });
  }

  // --- plugin databases (synced SQLite) --------------------------------------

  private pluginDbPath(vaultId: string, pluginId: string, name: string, suffix = ""): string {
    const p = encodeURIComponent(pluginId);
    const n = encodeURIComponent(name);
    return `/api/vaults/${vaultId}/plugin-dbs/${p}/${n}${suffix}`;
  }

  /** Pull the server replica's changeset past `cursor` (bootstrap / rebase). */
  async pluginDbChanges(
    vaultId: string,
    pluginId: string,
    name: string,
    cursor: Record<string, number>,
  ): Promise<import("./pluginDb/types").ChangeRow[]> {
    const since = encodeURIComponent(JSON.stringify(cursor ?? {}));
    const res = await this.api<{ changes: import("./pluginDb/types").ChangeRow[] }>(
      this.pluginDbPath(vaultId, pluginId, name, `/changes?since=${since}`),
    );
    return res.changes ?? [];
  }

  /** Tell the server a publish happened, so it replicates + commits to git. */
  async touchPluginDb(vaultId: string, pluginId: string, name: string): Promise<void> {
    await this.api(this.pluginDbPath(vaultId, pluginId, name, "/touch"), {
      method: "POST",
      body: {},
    });
  }

  /** Purge a plugin database: delete the server replica + git dump (irreversible). */
  async deletePluginDb(vaultId: string, pluginId: string, name: string): Promise<void> {
    await this.api(this.pluginDbPath(vaultId, pluginId, name), { method: "DELETE" });
  }

  // --- git history + rollback --------------------------------------------------

  /** Page through the vault's git history (optionally one file's, `--follow`). */
  listHistoryCommits(
    vaultId: string,
    opts?: { limit?: number; before?: string; path?: string },
  ): Promise<import("./history/types").CommitListPage> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.before) params.set("before", opts.before);
    if (opts?.path) params.set("path", opts.path);
    const qs = params.toString();
    return this.api(`/api/vaults/${vaultId}/history/commits${qs ? `?${qs}` : ""}`);
  }

  /** Commit metadata plus its change list. */
  getHistoryCommit(vaultId: string, hash: string): Promise<import("./history/types").CommitDetail> {
    return this.api(`/api/vaults/${vaultId}/history/commits/${hash}`);
  }

  /** Full file tree at a commit. */
  getHistoryTree(vaultId: string, hash: string): Promise<import("./history/types").HistoryTree> {
    return this.api(`/api/vaults/${vaultId}/history/commits/${hash}/tree`);
  }

  /** One path's content at a commit (text, binary metadata, or absent). */
  getHistoryFile(
    vaultId: string,
    hash: string,
    path: string,
  ): Promise<import("./history/types").FileAtCommit> {
    return this.api(
      `/api/vaults/${vaultId}/history/commits/${hash}/file?path=${encodeURIComponent(path)}`,
    );
  }

  /** Raw bytes of a path at a commit; throws "blob no longer available" on 410. */
  async getHistoryBlob(vaultId: string, hash: string, path: string): Promise<ArrayBuffer> {
    const res = await requestUrl({
      url: `${this.baseUrl}/api/vaults/${vaultId}/history/commits/${hash}/blob?path=${encodeURIComponent(path)}`,
      method: "GET",
      headers: this.authHeaders,
      throw: false,
    });
    if (res.status === 401) {
      await this.clearSession();
      throw new AuthError("Session expired. Please sign in again.");
    }
    if (res.status === 410) throw new Error("blob no longer available");
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`history blob download failed: ${blobErrorMessage(res)}`);
    }
    return res.arrayBuffer;
  }

  /** Dry-run a rollback (admin only). */
  rollbackPreview(vaultId: string, hash: string): Promise<import("./history/types").RollbackPlan> {
    return this.api(`/api/vaults/${vaultId}/history/commits/${hash}/rollback/preview`, {
      method: "POST",
      body: {},
    });
  }

  /** Execute a rollback (admin only); `pluginDbs` opts databases in. */
  rollbackVault(
    vaultId: string,
    hash: string,
    pluginDbs: { plugin: string; name: string }[] = [],
  ): Promise<import("./history/types").RollbackResult> {
    return this.api(`/api/vaults/${vaultId}/history/commits/${hash}/rollback`, {
      method: "POST",
      body: { pluginDbs },
    });
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
const LEGACY_TOKEN_KEY = "realtime-session-token";
const KNOWN_SESSIONS_KEY = "realtime-known-sessions";

/**
 * SecretStorage ids must be lowercase alphanumeric/dashes and 64 chars max.
 * Use only hashes in the variable portion so arbitrary UUID/user id formats
 * cannot push the id over the limit or leave invalid punctuation behind.
 */
function serverSessionTokenKey(serverUrl: string, serverId: string): string {
  const hash = shortHash(`${normalizeServerUrl(serverUrl)}\n${serverId}`);
  return `${LEGACY_TOKEN_KEY}-server-${hash}`;
}

function sessionTokenKey(serverUrl: string, serverId: string, userId: string): string {
  const serverHash = shortHash(`${normalizeServerUrl(serverUrl)}\n${serverId}`);
  const userHash = shortHash(`${normalizeServerUrl(serverUrl)}\n${serverId}\n${userId}`);
  return `${LEGACY_TOKEN_KEY}-${serverHash}-${userHash}`;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
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
