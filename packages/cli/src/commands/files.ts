import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import { CliError, writeRtmd } from "../config";
import { ctxFrom, out, vaultClients } from "../context";
import { kindForPath, isExcluded } from "../kinds";
import { hashText, listRemote, scanLocal } from "../sync";
import { printTable } from "../output";

function readStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => (data += chunk));
		process.stdin.on("end", () => resolve(data));
		process.stdin.on("error", reject);
	});
}

function assertNotePath(relPath: string): void {
	if (kindForPath(relPath) !== "note") {
		throw new CliError(`${relPath} is not a note (.md); use \`rtmd attach\` for binary files`);
	}
}

export function registerFileCommands(program: Command): void {
	program
		.command("ls")
		.description("list files in the vault folder (or on the server with --remote)")
		.option("--remote", "list the server's view of the vault")
		.action(async (opts: { remote?: boolean }) => {
			const ctx = ctxFrom(program);
			const { ws, vault } = vaultClients(ctx);
			if (opts.remote) {
				const remote = await listRemote(vault);
				const rows = [...remote.entries()].sort(([a], [b]) => a.localeCompare(b));
				out(
					ctx,
					rows.map(([p, e]) => ({ path: p, kind: e.kind })),
					() => printTable(rows.map(([p, e]) => [e.kind, p])),
				);
			} else {
				const local = scanLocal(ws.dir, ws.config.sync?.files ?? {});
				const rows = [...local.entries()].sort(([a], [b]) => a.localeCompare(b));
				out(
					ctx,
					rows.map(([p, e]) => ({ path: p, kind: e.kind, size: e.size })),
					() => printTable(rows.map(([p, e]) => [e.kind, p])),
				);
			}
		});

	program
		.command("mv <from> <to>")
		.description("move/rename a file locally and in the vault")
		.action(async (from: string, to: string) => {
			const ctx = ctxFrom(program);
			const { ws, vault } = vaultClients(ctx);
			if (isExcluded(from) || isExcluded(to)) throw new CliError("cannot move excluded (dot) paths");
			const kind = kindForPath(from);
			if (kindForPath(to) !== kind) {
				throw new CliError(`cannot change file kind in a move (${kind} → ${kindForPath(to)})`);
			}
			if (kind === "note") await vault.notes.move(from, to);
			else if (kind === "canvas") await vault.canvases.move(from, to);
			else if (kind === "base") await vault.bases.move(from, to);
			else await vault.attachments.move(from, to, { updateEmbeds: true });

			const absFrom = path.join(ws.dir, from);
			if (fs.existsSync(absFrom)) {
				const absTo = path.join(ws.dir, to);
				fs.mkdirSync(path.dirname(absTo), { recursive: true });
				fs.renameSync(absFrom, absTo);
			}
			const files = ws.config.sync?.files;
			if (files?.[from]) {
				files[to] = files[from];
				delete files[from];
				writeRtmd(ws.dir, ws.config);
			}
			process.stderr.write(`moved ${from} → ${to}\n`);
		});

	program
		.command("rm <path>")
		.description("delete a file from the vault and the local folder")
		.action(async (relPath: string) => {
			const ctx = ctxFrom(program);
			const { ws, vault } = vaultClients(ctx);
			const kind = kindForPath(relPath);
			if (kind === "note") await vault.notes.delete(relPath);
			else if (kind === "canvas") await vault.canvases.delete(relPath);
			else if (kind === "base") await vault.bases.delete(relPath);
			else await vault.attachments.delete(relPath);
			fs.rmSync(path.join(ws.dir, relPath), { force: true });
			if (ws.config.sync?.files[relPath]) {
				delete ws.config.sync.files[relPath];
				writeRtmd(ws.dir, ws.config);
			}
			process.stderr.write(`deleted ${relPath}\n`);
		});

	program
		.command("cat <path>")
		.description("print a note's content from the server")
		.action(async (relPath: string) => {
			const ctx = ctxFrom(program);
			const { vault } = vaultClients(ctx);
			assertNotePath(relPath);
			const note = await vault.notes.read(relPath);
			out(ctx, note, () => process.stdout.write(note.content));
		});

	program
		.command("write <path>")
		.description("create or replace a note from stdin (or --file)")
		.option("--file <localPath>", "read content from a file instead of stdin")
		.action(async (relPath: string, opts: { file?: string }) => {
			const ctx = ctxFrom(program);
			const { ws, vault } = vaultClients(ctx);
			assertNotePath(relPath);
			const content = opts.file ? fs.readFileSync(opts.file, "utf8") : await readStdin();
			const remote = await vault.notes.list();
			const exists = remote.some((n) => n.path === relPath);
			const note = exists ? await vault.notes.replace(relPath, content) : await vault.notes.create(relPath, content);
			syncLocalNote(ws, relPath, note.content, note.guid);
			process.stderr.write(`wrote ${relPath}\n`);
		});

	program
		.command("append <path> <text>")
		.description("append a line of text to a note")
		.action(async (relPath: string, text: string) => {
			const ctx = ctxFrom(program);
			const { ws, vault } = vaultClients(ctx);
			assertNotePath(relPath);
			const note = await vault.notes.append(relPath, text);
			syncLocalNote(ws, relPath, note.content, note.guid);
			process.stderr.write(`appended to ${relPath}\n`);
		});

	program
		.command("patch <path>")
		.description("replace a text fragment in a note")
		.requiredOption("--old <text>", "exact text to replace")
		.requiredOption("--new <text>", "replacement text")
		.option("--all", "replace every occurrence")
		.action(async (relPath: string, opts: { old: string; new: string; all?: boolean }) => {
			const ctx = ctxFrom(program);
			const { ws, vault } = vaultClients(ctx);
			assertNotePath(relPath);
			const note = await vault.notes.patch(relPath, { old: opts.old, new: opts.new, replaceAll: opts.all });
			syncLocalNote(ws, relPath, note.content, note.guid);
			process.stderr.write(`patched ${relPath}\n`);
		});

	program
		.command("permalink <path>")
		.description("get a stable permalink for a note")
		.action(async (relPath: string) => {
			const ctx = ctxFrom(program);
			const { vault } = vaultClients(ctx);
			assertNotePath(relPath);
			const res = await vault.notes.permalink(relPath);
			out(ctx, res, () => process.stdout.write(`${res.url}\n`));
		});

	// Keep the local copy and snapshot in step after a remote-side note edit so
	// the next `pull`/`push` doesn't see a phantom change.
	function syncLocalNote(
		ws: ReturnType<typeof vaultClients>["ws"],
		relPath: string,
		content: string,
		guid: string,
	): void {
		const abs = path.join(ws.dir, relPath);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
		ws.config.sync ??= { lastSyncedAt: new Date().toISOString(), files: {} };
		const stat = fs.statSync(abs);
		ws.config.sync.files[relPath] = {
			kind: "note",
			hash: hashText(content),
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			guid,
		};
		writeRtmd(ws.dir, ws.config);
	}
}
