import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import { chooseVault, loginUser, settleFolderAuth } from "../auth";
import { requireUserClient } from "../client";
import { readRtmd, writeRtmd, type RtmdConfig } from "../config";
import { ctxFrom, out, workspace } from "../context";
import { ask } from "../prompt";

export function registerAuthCommands(program: Command): void {
  program
    .command("login [dir]")
    .description("log in and bind a folder to a vault (writes .rtmd)")
    .option("--base-url <url>", "server origin, e.g. https://realtime.example.com")
    .option("--paste", "paste a session token instead of using the browser")
    .option("--vault <idOrName>", "skip the vault picker")
    .action(
      async (
        dirArg: string | undefined,
        opts: { baseUrl?: string; paste?: boolean; vault?: string },
      ) => {
        const ctx = ctxFrom(program);
        const dir = path.resolve(
          ctx.startDir,
          dirArg ?? (process.stdin.isTTY ? await ask("Folder to bind to a vault", ".") : "."),
        );
        fs.mkdirSync(dir, { recursive: true });
        const existing = fs.existsSync(path.join(dir, ".rtmd")) ? readRtmd(dir) : undefined;

        const session = await loginUser({
          baseUrl: opts.baseUrl ?? existing?.baseUrl,
          paste: opts.paste,
        });
        const vault = await chooseVault(session.client, opts.vault ?? existing?.vaultId);
        const auth = await settleFolderAuth(session, vault, dir);

        const config: RtmdConfig = {
          version: 1,
          baseUrl: session.baseUrl,
          vaultId: vault.id,
          vaultName: vault.name,
          auth,
          // Keep the snapshot only when the folder stays bound to the same vault.
          sync: existing && existing.vaultId === vault.id ? existing.sync : undefined,
        };
        writeRtmd(dir, config);
        process.stderr.write(
          `Logged in. ${dir} is bound to vault "${vault.name}" (${auth.mode} auth). Run \`rtmd pull\` to download it.\n`,
        );
      },
    );

  program
    .command("logout")
    .description("invalidate and remove this folder's credentials (keeps the vault binding)")
    .action(async () => {
      const ctx = ctxFrom(program);
      const ws = workspace(ctx);
      const auth = ws.config.auth;
      if (!auth) {
        process.stderr.write("already logged out\n");
        return;
      }
      if (auth.mode === "user") {
        await requireUserClient(ws)
          .logout()
          .catch(() => {});
      } else {
        process.stderr.write(
          "removing the remote-cursor token from this folder; the cursor itself still exists " +
            "(delete it with `rtmd cursor rm` from a user-authenticated folder)\n",
        );
      }
      delete ws.config.auth;
      writeRtmd(ws.dir, ws.config);
      process.stderr.write("logged out\n");
    });

  program
    .command("whoami")
    .description("show the identity and auth mode for this folder")
    .action(async () => {
      const ctx = ctxFrom(program);
      const ws = workspace(ctx);
      const auth = ws.config.auth;
      const base = {
        baseUrl: ws.config.baseUrl,
        vaultId: ws.config.vaultId,
        vaultName: ws.config.vaultName,
        authMode: auth?.mode ?? null,
      };
      if (auth?.mode === "user") {
        const me = await requireUserClient(ws).me();
        out(ctx, { ...base, ...me }, () => {
          process.stdout.write(`${me.displayName} <${me.email}> (user session)\n`);
          process.stdout.write(`vault: ${base.vaultName ?? base.vaultId} @ ${base.baseUrl}\n`);
        });
      } else if (auth) {
        const cursorName = "cursorName" in auth ? auth.cursorName : undefined;
        out(ctx, { ...base, cursorName }, () => {
          process.stdout.write(
            `remote cursor${cursorName ? ` "${cursorName}"` : ""} (${auth.mode} auth)\n`,
          );
          process.stdout.write(`vault: ${base.vaultName ?? base.vaultId} @ ${base.baseUrl}\n`);
        });
      } else {
        out(ctx, base, () => {
          process.stdout.write(
            `not logged in (vault binding: ${base.vaultName ?? base.vaultId} @ ${base.baseUrl})\n`,
          );
        });
      }
    });
}
