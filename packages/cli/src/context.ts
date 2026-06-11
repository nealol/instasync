/** Per-invocation context derived from global flags. */

import type { Command } from "commander";
import { requireWorkspace, type Workspace } from "./config";
import { makeClients, requireUserClient, type BoundClients } from "./client";
import { printJson } from "./output";
import type { RealtimeClient, VaultHandle } from "@realtime-md/sdk";

export interface Ctx {
	startDir: string;
	json: boolean;
}

export function ctxFrom(cmd: Command): Ctx {
	// Global options live on the root program.
	let root: Command = cmd;
	while (root.parent) root = root.parent;
	const opts = root.opts<{ dir?: string; json?: boolean }>();
	return { startDir: opts.dir ?? process.cwd(), json: opts.json ?? false };
}

export function workspace(ctx: Ctx): Workspace {
	return requireWorkspace(ctx.startDir);
}

export function vaultClients(ctx: Ctx): { ws: Workspace; clients: BoundClients; vault: VaultHandle } {
	const ws = workspace(ctx);
	const clients = makeClients(ws);
	return { ws, clients, vault: clients.vault };
}

export function userVault(ctx: Ctx): { ws: Workspace; client: RealtimeClient; vault: VaultHandle } {
	const ws = workspace(ctx);
	const client = requireUserClient(ws);
	return { ws, client, vault: client.vault(ws.config.vaultId) };
}

/** Print `value` as JSON under --json, otherwise run the human renderer. */
export function out(ctx: Ctx, value: unknown, human: () => void): void {
	if (ctx.json) printJson(value);
	else human();
}
