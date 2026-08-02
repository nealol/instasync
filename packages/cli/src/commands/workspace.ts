import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import { chooseVault, loginUser, settleFolderAuth } from "../auth";
import { makeClients, liveToStoredTokens } from "../client";
import {
  CliError,
  findRtmdDir,
  writeRtmd,
  type AuthConfig,
  type RtmdConfig,
  type Workspace,
} from "../config";
import { ctxFrom, out, vaultClients, type Ctx } from "../context";
import { ask } from "../prompt";
import { filteredSnapshot, parseAttachmentGlobs } from "../attachmentFilter";
import { classifyStatus, listRemote, pull, push, scanLocal, type SyncReport } from "../sync";

function reportSync(ctx: Ctx, report: SyncReport, direction: "pull" | "push"): void {
  out(ctx, report, () => {
    for (const a of report.applied) process.stdout.write(`${a.action}: ${a.path}\n`);
    for (const c of report.conflicts) process.stderr.write(`conflict: ${c.path} — ${c.reason}\n`);
    const noun = direction === "pull" ? "pulled" : "pushed";
    process.stdout.write(
      `${report.applied.length} ${noun}, ${report.conflicts.length} conflict(s)\n`,
    );
  });
  if (report.conflicts.length > 0) process.exitCode = 1;
}

function ensureUnbound(dir: string): void {
  const existing = findRtmdDir(dir);
  if (existing) {
    throw new CliError(
      `${dir} is already inside an rtmd vault folder (${existing}); run this somewhere else`,
    );
  }
}

export function registerWorkspaceCommands(program: Command): void {
  program
    .command("init [dir]")
    .description("create a new vault from a folder (empty or with existing files) and bind it")
    .option("--name <name>", "vault name (defaults to the folder name)")
    .option("--base-url <url>", "server origin")
    .option("--paste", "paste a session token instead of using the browser")
    .option("--no-attachments", "ignore all non-Markdown attachments")
    .option(
      "--attachment-filter <globs>",
      "comma-separated attachment include globs; non-matches are ignored",
    )
    .action(
      async (
        dirArg: string | undefined,
        opts: {
          name?: string;
          baseUrl?: string;
          paste?: boolean;
          attachments: boolean;
          attachmentFilter?: string;
        },
      ) => {
        const ctx = ctxFrom(program);
        const dir = path.resolve(ctx.startDir, dirArg ?? ".");
        fs.mkdirSync(dir, { recursive: true });
        ensureUnbound(dir);

        const session = await loginUser({ baseUrl: opts.baseUrl, paste: opts.paste });
        const name = opts.name ?? (await ask("Vault name", path.basename(dir)));
        const vault = await session.client.vaults.create(name);
        const auth = await settleFolderAuth(session, vault, dir);

        const config: RtmdConfig = {
          version: 1,
          baseUrl: session.baseUrl,
          vaultId: vault.id,
          vaultName: vault.name,
          auth,
          attachmentSync: {
            enabled: opts.attachments,
            includeGlobs: parseAttachmentGlobs(opts.attachmentFilter ?? ""),
          },
        };
        writeRtmd(dir, config);
        process.stderr.write(
          `Created vault "${vault.name}" (${vault.id}); pushing folder contents…\n`,
        );

        const ws: Workspace = { dir, config };
        const report = await push(ws, makeClients(ws).vault);
        reportSync(ctx, report, "push");
      },
    );

  program
    .command("clone <vault> [dir]")
    .description("download a vault into a new folder and bind it")
    .option("--base-url <url>", "server origin")
    .option("--paste", "paste a session token instead of using the browser")
    .option("--no-attachments", "ignore all non-Markdown attachments")
    .option(
      "--attachment-filter <globs>",
      "comma-separated attachment include globs; non-matches are ignored",
    )
    .option(
      "--cursor-token <token>",
      "authenticate as a remote cursor (vault must be an id; no browser login)",
    )
    .option(
      "--cursor-oauth <mcpUrl>",
      "OAuth-delegate a remote cursor by its MCP URL (vault must be an id)",
    )
    .action(
      async (
        vaultArg: string,
        dirArg: string | undefined,
        opts: {
          baseUrl?: string;
          paste?: boolean;
          cursorToken?: string;
          cursorOauth?: string;
          attachments: boolean;
          attachmentFilter?: string;
        },
      ) => {
        const ctx = ctxFrom(program);
        let baseUrl = opts.baseUrl;
        let auth: AuthConfig;
        let vaultId = vaultArg;
        let vaultName: string | undefined;

        if (opts.cursorToken || opts.cursorOauth) {
          if (!baseUrl) baseUrl = await ask("Server URL (e.g. https://realtime.example.com)");
          baseUrl = baseUrl.replace(/\/+$/, "");
          if (opts.cursorToken) {
            auth = { mode: "cursor", token: opts.cursorToken };
          } else {
            const { loginCursorViaOAuth } = await import("@realtime-md/sdk/node");
            const session = await loginCursorViaOAuth({ baseUrl, mcpUrl: opts.cursorOauth! });
            auth = {
              mode: "cursor-oauth",
              clientId: session.clientId,
              tokens: liveToStoredTokens(session.tokens),
            };
          }
        } else {
          const session = await loginUser({ baseUrl, paste: opts.paste });
          const vault = await chooseVault(session.client, vaultArg);
          baseUrl = session.baseUrl;
          vaultId = vault.id;
          vaultName = vault.name;
          auth = await settleFolderAuth(session, vault, dirArg ?? vault.name);
        }

        const dir = path.resolve(ctx.startDir, dirArg ?? vaultName ?? vaultId);
        fs.mkdirSync(dir, { recursive: true });
        ensureUnbound(dir);

        const config: RtmdConfig = {
          version: 1,
          baseUrl: baseUrl!,
          vaultId,
          vaultName,
          auth,
          attachmentSync: {
            enabled: opts.attachments,
            includeGlobs: parseAttachmentGlobs(opts.attachmentFilter ?? ""),
          },
        };
        writeRtmd(dir, config);
        process.stderr.write(`Cloning into ${dir}…\n`);

        const ws: Workspace = { dir, config };
        const report = await pull(ws, makeClients(ws).vault);
        reportSync(ctx, report, "pull");
      },
    );

  program
    .command("status")
    .description("show local and remote changes since the last sync")
    .action(async () => {
      const ctx = ctxFrom(program);
      const { ws, vault } = vaultClients(ctx);
      const snapshot = filteredSnapshot(ws.config, ws.config.sync?.files ?? {});
      const local = scanLocal(ws.dir, snapshot, ws.config);
      const remote = await listRemote(vault, ws.config);
      const entries = classifyStatus(local, snapshot, remote);
      out(ctx, entries, () => {
        if (entries.length === 0) {
          process.stdout.write("up to date\n");
          return;
        }
        for (const e of entries) {
          const sides = [
            e.local ? `local ${e.local}` : null,
            e.remote ? `remote ${e.remote}` : null,
          ].filter(Boolean);
          process.stdout.write(`${e.path} (${sides.join(", ")})\n`);
        }
        process.stdout.write(
          "\nnote: remote edits to notes/canvases/bases are detected during pull, not status\n",
        );
      });
    });

  program
    .command("pull")
    .description("apply remote changes to this folder")
    .option("--theirs", "overwrite local edits on conflict")
    .action(async (opts: { theirs?: boolean }) => {
      const ctx = ctxFrom(program);
      const { ws, vault } = vaultClients(ctx);
      reportSync(ctx, await pull(ws, vault, { theirs: opts.theirs }), "pull");
    });

  program
    .command("push")
    .description("apply local changes to the vault")
    .option("--force", "overwrite remote edits on conflict")
    .action(async (opts: { force?: boolean }) => {
      const ctx = ctxFrom(program);
      const { ws, vault } = vaultClients(ctx);
      reportSync(ctx, await push(ws, vault, { force: opts.force }), "push");
    });
}
