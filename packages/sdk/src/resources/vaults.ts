import type { Http } from "../http";
import type {
	CreatedRemoteCursor,
	CursorAuditPage,
	InviteResponse,
	MemberInfo,
	PluginCursorGrant,
	RedeemResponse,
	RemoteCursorInfo,
	SecretTokenResponse,
	VaultInfo,
} from "../types";

export class VaultsResource {
	constructor(private http: Http) {}

	list(): Promise<VaultInfo[]> {
		return this.http.request("GET", "/api/vaults");
	}

	/** Create a new remote vault; the caller becomes its admin/owner. */
	create(name: string): Promise<VaultInfo> {
		return this.http.request("POST", "/api/vaults", { body: { name } });
	}
}

export class InvitesResource {
	constructor(private http: Http) {}

	/** Mint an invite code for a vault (admin only). Defaults to member role. */
	create(vaultId: string, opts: { role?: "admin" | "member" } = {}): Promise<InviteResponse> {
		return this.http.request("POST", `/api/vaults/${vaultId}/invites`, { body: { role: opts.role } });
	}

	redeem(code: string): Promise<RedeemResponse> {
		return this.http.request("POST", "/api/invites/redeem", { body: { code } });
	}
}

export class MembersResource {
	constructor(
		private http: Http,
		private vaultId: string,
	) {}

	list(): Promise<MemberInfo[]> {
		return this.http.request("GET", `/api/vaults/${this.vaultId}/members`);
	}

	promote(userId: string): Promise<MemberInfo> {
		return this.http.request("POST", `/api/vaults/${this.vaultId}/members/${userId}/promote`);
	}

	async remove(userId: string): Promise<void> {
		await this.http.request("DELETE", `/api/vaults/${this.vaultId}/members/${userId}`);
	}
}

export class CursorsResource {
	constructor(
		private http: Http,
		private vaultId: string,
	) {}

	list(): Promise<RemoteCursorInfo[]> {
		return this.http.request("GET", `/api/vaults/${this.vaultId}/cursors`);
	}

	/** Create an admin-managed cursor; the secret token is returned exactly once. */
	create(name: string): Promise<CreatedRemoteCursor> {
		return this.http.request("POST", `/api/vaults/${this.vaultId}/cursors`, { body: { name } });
	}

	rename(cursorId: string, name: string): Promise<RemoteCursorInfo> {
		return this.http.request("POST", `/api/vaults/${this.vaultId}/cursors/${cursorId}`, { body: { name } });
	}

	async delete(cursorId: string): Promise<void> {
		await this.http.request("DELETE", `/api/vaults/${this.vaultId}/cursors/${cursorId}`);
	}

	regenerateToken(cursorId: string): Promise<SecretTokenResponse> {
		return this.http.request("POST", `/api/vaults/${this.vaultId}/cursors/${cursorId}/token`);
	}

	/**
	 * Get-or-create the plugin-managed cursor for `pluginId` and mint a fresh
	 * device token (each device gets its own token row; ~30-day TTL).
	 */
	acquirePlugin(pluginId: string, name?: string): Promise<PluginCursorGrant> {
		return this.http.request("POST", `/api/vaults/${this.vaultId}/cursors/plugin`, {
			body: { pluginId, name },
		});
	}

	audit(cursorId: string): CursorAuditResource {
		return new CursorAuditResource(this.http, this.vaultId, cursorId);
	}
}

export class CursorAuditResource {
	constructor(
		private http: Http,
		private vaultId: string,
		private cursorId: string,
	) {}

	/** Keyset-paginated audit entries, newest first (admin only). */
	list(opts: { before?: number; limit?: number } = {}): Promise<CursorAuditPage> {
		return this.http.request("GET", `/api/vaults/${this.vaultId}/cursors/${this.cursorId}/audit`, {
			query: { before: opts.before, limit: opts.limit },
		});
	}

	/** Revert one audited mutation; `force` overrides conflict detection. */
	async undo(entryId: string, opts: { force?: boolean } = {}): Promise<void> {
		await this.http.request(
			"POST",
			`/api/vaults/${this.vaultId}/cursors/${this.cursorId}/audit/${entryId}/undo`,
			{ body: { force: opts.force ?? false } },
		);
	}
}
