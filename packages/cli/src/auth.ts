/**
 * Interactive login: browser (or pasted-token) user login, vault choice, and
 * the optional login-to-cursor hand-off where an admin mints a remote cursor
 * for the folder and the personal session token is discarded.
 */

import * as path from "node:path";
import { RealtimeClient, type VaultInfo } from "@realtime-md/sdk";
import { clientFromPastedToken, loginViaBrowser } from "@realtime-md/sdk/node";
import { CliError, type AuthConfig } from "./config";
import { ask, confirm, pick } from "./prompt";

export interface LoginOptions {
	baseUrl?: string;
	/** Paste a token from {baseUrl}/auth/login instead of the browser flow. */
	paste?: boolean;
}

export interface UserSession {
	client: RealtimeClient;
	baseUrl: string;
	token: string;
}

/** Step 1+2 of the login flow: resolve the server and obtain a user session. */
export async function loginUser(opts: LoginOptions): Promise<UserSession> {
	const baseUrl = (opts.baseUrl ?? (await ask("Server URL (e.g. https://realtime.example.com)"))).replace(/\/+$/, "");
	if (!/^https?:\/\//.test(baseUrl)) throw new CliError(`invalid server URL: ${baseUrl}`);
	let token: string;
	if (opts.paste) {
		process.stderr.write(`Visit ${baseUrl}/auth/login in a browser and copy the token shown.\n`);
		token = await ask("Session token");
		await clientFromPastedToken(baseUrl, token);
	} else {
		process.stderr.write("Opening your browser to log in…\n");
		token = await loginViaBrowser({ baseUrl });
	}
	return { client: new RealtimeClient({ baseUrl, token }), baseUrl, token };
}

/** Step 3: pick a vault, by `--vault` id/name when given, interactively otherwise. */
export async function chooseVault(client: RealtimeClient, vaultArg?: string): Promise<VaultInfo> {
	const vaults = await client.vaults.list();
	if (vaultArg) {
		const match =
			vaults.find((v) => v.id === vaultArg) ?? vaults.find((v) => v.name === vaultArg);
		if (!match) throw new CliError(`no vault named or with id "${vaultArg}" (you have ${vaults.length})`);
		return match;
	}
	if (vaults.length === 0) {
		throw new CliError("you have no vaults; create one with `rtmd init` or `rtmd vault create <name>`");
	}
	return pick("Choose a vault", vaults, (v) => `${v.name} (${v.role}${v.owner ? ", owner" : ""}) ${v.id}`);
}

/**
 * Step 4: decide what credentials the folder keeps. Admins are offered a
 * dedicated remote cursor (auditable, vault-scoped) in place of their personal
 * session token; when they accept, the temporary session is invalidated.
 */
export async function settleFolderAuth(
	session: UserSession,
	vault: VaultInfo,
	folderDir: string,
	opts: { nonInteractive?: boolean } = {},
): Promise<AuthConfig> {
	if (vault.role === "admin" && !opts.nonInteractive && process.stdin.isTTY) {
		const wantCursor = await confirm(
			"Create a remote cursor for this folder instead of storing your personal session token?",
		);
		if (wantCursor) {
			const defaultName = `cli:${path.basename(path.resolve(folderDir))}`;
			const name = await ask("Cursor name", defaultName);
			const created = await session.client.vault(vault.id).cursors.create(name);
			// Cursor tokens are independent of user sessions, so the temporary
			// session can be invalidated immediately.
			await session.client.logout().catch(() => {});
			process.stderr.write(`Created remote cursor "${created.name}"; this folder now acts as that cursor.\n`);
			return { mode: "cursor", token: created.secretToken, cursorId: created.id, cursorName: created.name };
		}
	}
	return { mode: "user", token: session.token };
}
