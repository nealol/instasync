import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import { ctxFrom, out, vaultClients } from "../context";
import { formatBytes, printTable } from "../output";

export function registerAttachCommands(program: Command): void {
	const attach = program.command("attach").description("binary attachments (pull/push cover the common case)");

	attach
		.command("ls")
		.description("list attachments on the server")
		.action(async () => {
			const ctx = ctxFrom(program);
			const { vault } = vaultClients(ctx);
			const list = await vault.attachments.list();
			out(ctx, list, () =>
				printTable(
					list.map((a) => [formatBytes(a.size), a.hash.slice(0, 12), a.path]),
					["size", "hash", "path"],
				),
			);
		});

	attach
		.command("get <path> [outFile]")
		.description("download an attachment (defaults to its basename in the cwd)")
		.action(async (relPath: string, outFile: string | undefined) => {
			const ctx = ctxFrom(program);
			const { vault } = vaultClients(ctx);
			const bytes = await vault.attachments.read(relPath);
			const target = outFile ?? path.basename(relPath);
			fs.writeFileSync(target, bytes);
			process.stderr.write(`wrote ${target} (${formatBytes(bytes.length)})\n`);
		});

	attach
		.command("put <localFile> [vaultPath]")
		.description("upload a file as an attachment (defaults to its basename)")
		.action(async (localFile: string, vaultPath: string | undefined) => {
			const ctx = ctxFrom(program);
			const { vault } = vaultClients(ctx);
			const bytes = fs.readFileSync(localFile);
			const target = vaultPath ?? path.basename(localFile);
			const res = await vault.attachments.upload(target, bytes);
			out(ctx, res, () => process.stderr.write(`uploaded ${res.path} (${formatBytes(res.size)})\n`));
		});

	attach
		.command("from-url <sourceUrl> <vaultPath>")
		.description("server-side fetch of a URL into the vault")
		.action(async (sourceUrl: string, vaultPath: string) => {
			const ctx = ctxFrom(program);
			const { vault } = vaultClients(ctx);
			const res = await vault.attachments.uploadFromUrl(sourceUrl, vaultPath);
			out(ctx, res, () => process.stderr.write(`uploaded ${res.path} (${formatBytes(res.size)})\n`));
		});

	attach
		.command("rm <path>")
		.description("delete an attachment from the vault")
		.action(async (relPath: string) => {
			const ctx = ctxFrom(program);
			const { vault } = vaultClients(ctx);
			await vault.attachments.delete(relPath);
			process.stderr.write(`deleted ${relPath}\n`);
		});
}
