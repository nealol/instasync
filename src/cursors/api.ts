/**
 * Public, plugin-author-facing API for plugin-managed remote cursors,
 * reachable as `app.plugins.plugins["realtime"].cursors`.
 *
 * A plugin acquires a remote cursor identity for the active vault; edits made
 * with the returned bearer token (REST, MCP, or the streaming WebSocket) are
 * attributed in Git to the cursor robot on behalf of the current user, instead
 * of looking like ordinary human edits.
 *
 * The handle's `notes` methods perform those edits locally — plain function
 * calls, no WebSocket or token plumbing — and every mutation lands in the
 * cursor's audit log (undoable by admins for ~3 days) with robot Git
 * attribution, exactly like MCP and streaming edits.
 */

import { requestUrl } from "obsidian";
import type {
	AcquireCursorOptions,
	CursorNote,
	CursorNoteSummary,
	CursorNotesApi,
	RealtimeCursors,
	RemoteCursorHandle,
} from "@realtime-md/plugin-api-types";
import type RealtimePlugin from "../main";
import { normalizeServerUrl } from "../auth";
import { isValidId } from "../pluginDb/types";

// Public interfaces live in the published types package; re-export for
// internal callers and docs links.
export type { AcquireCursorOptions, CursorNote, CursorNoteSummary, CursorNotesApi, RemoteCursorHandle };

/** Re-acquire when the cached token has less than a day left. */
const EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000;

export class RealtimeCursorsAPI implements RealtimeCursors {
	private plugin: RealtimePlugin;
	private cache = new Map<string, RemoteCursorHandle>();

	constructor(plugin: RealtimePlugin) {
		this.plugin = plugin;
	}

	/**
	 * Get-or-create this plugin's remote cursor for the active vault and return
	 * a handle with a live bearer token. Tokens are cached per session and
	 * re-minted when close to expiry; call {@link invalidate} after a 401.
	 */
	async acquire(opts: AcquireCursorOptions): Promise<RemoteCursorHandle> {
		if (!isValidId(opts.pluginId)) {
			throw new Error(`pluginId must match [A-Za-z0-9_-]{1,80} without "__": ${opts.pluginId}`);
		}
		this.requireAvailable();
		const vaultId = this.plugin.settings.activeVaultId;
		const key = `${vaultId}__${opts.pluginId}`;
		const cached = this.cache.get(key);
		if (cached && cached.expiresAt - Date.now() > EXPIRY_MARGIN_MS) return cached;

		const grant = await this.plugin.auth.acquirePluginCursor(vaultId, opts.pluginId, opts.name);
		const handle: RemoteCursorHandle = {
			cursorId: grant.id,
			appId: grant.appId,
			vaultId: grant.vaultId,
			name: grant.name,
			token: grant.secretToken,
			baseUrl: normalizeServerUrl(this.plugin.settings.authServerUrl),
			mcpUrl: grant.mcpUrl,
			streamUrl: grant.streamUrl,
			expiresAt: grant.expiresAt,
			notes: this.makeNotesApi(opts.pluginId),
		};
		this.cache.set(key, handle);
		return handle;
	}

	/**
	 * Note operations bound to a plugin id. Every call resolves the current
	 * vault and a live token via {@link acquire} (cached), so handles stay
	 * valid across token expiry and vault switches.
	 */
	private makeNotesApi(pluginId: string): CursorNotesApi {
		const note = (path: string) => `/api/vaults/{vault}/notes/${encodePath(path)}`;
		return {
			list: () => this.request<CursorNoteSummary[]>(pluginId, "GET", "/api/vaults/{vault}/notes"),
			read: (path) => this.request<CursorNote>(pluginId, "GET", note(path)),
			create: (path, content = "") =>
				this.request<CursorNote>(pluginId, "POST", "/api/vaults/{vault}/notes", { path, content }),
			replace: (path, content) => this.request<CursorNote>(pluginId, "PUT", note(path), { content }),
			patch: (path, edit) =>
				this.request<CursorNote>(pluginId, "PATCH", note(path), {
					old: edit.old,
					new: edit.new,
					replaceAll: edit.replaceAll ?? false,
				}),
			append: async (path, text) => {
				const current = await this.request<CursorNote>(pluginId, "GET", note(path));
				const glue = current.content.length === 0 || current.content.endsWith("\n") ? "" : "\n";
				return this.request<CursorNote>(pluginId, "PUT", note(path), {
					content: `${current.content}${glue}${text}`,
				});
			},
			move: (path, toPath) =>
				this.request<CursorNote>(
					pluginId,
					"POST",
					`/api/vaults/{vault}/note-moves/${encodePath(path)}`,
					{ toPath },
				),
			delete: async (path) => {
				await this.request(pluginId, "DELETE", note(path));
			},
		};
	}

	/**
	 * One REST call authenticated with the cursor's bearer token. `{vault}` in
	 * `path` is replaced with the active vault id. A 401 (expired/revoked
	 * token) re-acquires once and retries; other errors surface the server's
	 * `error` message.
	 */
	private async request<T>(
		pluginId: string,
		method: string,
		path: string,
		body?: unknown,
		retried = false,
	): Promise<T> {
		const handle = await this.acquire({ pluginId });
		const res = await requestUrl({
			url: `${handle.baseUrl}${path.replace("{vault}", handle.vaultId)}`,
			method,
			contentType: body !== undefined ? "application/json" : undefined,
			headers: { Authorization: `Bearer ${handle.token}` },
			body: body !== undefined ? JSON.stringify(body) : undefined,
			throw: false,
		});
		if (res.status === 401 && !retried) {
			this.invalidate(pluginId);
			return this.request<T>(pluginId, method, path, body, true);
		}
		if (res.status < 200 || res.status >= 300) {
			const msg = (res.json as { error?: string })?.error ?? `HTTP ${res.status}`;
			throw new Error(msg);
		}
		return res.json as T;
	}

	/** Drop the cached token for a plugin (e.g. after a 401) so the next acquire re-mints. */
	invalidate(pluginId: string): void {
		this.cache.delete(`${this.plugin.settings.activeVaultId}__${pluginId}`);
	}

	/** Forget all cached tokens (plugin unload). */
	destroy(): void {
		this.cache.clear();
	}

	private requireAvailable(): void {
		if (!this.plugin.settings.enabled) throw new Error("Realtime is disabled in settings.");
		if (!this.plugin.auth.isLoggedIn) throw new Error("Realtime is signed out — sign in first.");
		if (!this.plugin.settings.activeVaultId) throw new Error("Realtime has no active vault.");
	}
}

/** Vault-relative path → URL path segments (slashes kept as separators). */
function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}
