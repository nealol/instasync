import type { Command } from "commander";
import { ctxFrom, out, userVault, vaultClients } from "../context";
import { formatTime, printTable } from "../output";
import { confirm } from "../prompt";

export function registerHistoryCommands(program: Command): void {
  const history = program.command("history").description("browse the vault's git history");

  history
    .command("log [path]")
    .description("list commits (optionally for one file)")
    .option("--limit <n>", "max commits", (v) => parseInt(v, 10), 20)
    .option("--before <hash>", "page: list commits before this hash")
    .action(async (relPath: string | undefined, opts: { limit: number; before?: string }) => {
      const ctx = ctxFrom(program);
      const { vault } = vaultClients(ctx);
      const page = await vault.history.listCommits({
        limit: opts.limit,
        before: opts.before,
        path: relPath,
      });
      out(ctx, page, () => {
        printTable(
          page.commits.map((c) => [
            c.shortHash,
            formatTime(c.timestampMs),
            c.cursorName ? `cursor:${c.cursorName}` : c.authorName,
            c.subject,
          ]),
        );
        if (page.hasMore && page.commits.length > 0) {
          process.stdout.write(`…more: --before ${page.commits[page.commits.length - 1].hash}\n`);
        }
      });
    });

  history
    .command("show <hash> [path]")
    .description("show a commit's changes, or one file's content at that commit")
    .action(async (hash: string, relPath: string | undefined) => {
      const ctx = ctxFrom(program);
      const { vault } = vaultClients(ctx);
      if (relPath) {
        const file = await vault.history.getFile(hash, relPath);
        out(ctx, file, () => {
          if (file.type === "text") process.stdout.write(file.content);
          else if (file.type === "binary")
            process.stdout.write(`binary: ${file.hash} (${file.size} bytes)\n`);
          else process.stdout.write("absent at this commit\n");
        });
        return;
      }
      const detail = await vault.history.getCommit(hash);
      out(ctx, detail, () => {
        const c = detail.commit;
        process.stdout.write(`commit ${c.hash}\n`);
        process.stdout.write(
          `author ${c.authorName} <${c.authorEmail}> ${formatTime(c.timestampMs)}\n`,
        );
        if (c.cursorName) process.stdout.write(`cursor ${c.cursorName}\n`);
        process.stdout.write(`\n  ${c.subject}\n\n`);
        printTable(
          detail.changes.map((ch) => [
            ch.status,
            ch.renamedTo ? `${ch.path} → ${ch.renamedTo}` : ch.path,
          ]),
        );
      });
    });

  program
    .command("rollback <hash>")
    .description("roll the vault back to a commit (previews first; admin only)")
    .option("--yes", "apply without an interactive confirmation")
    .option("--path <p>", "scope the rollback to a single current vault path")
    .option("--target-path <p>", "path to read from the target commit (defaults to --path)")
    .action(async (hash: string, opts: { yes?: boolean; path?: string; targetPath?: string }) => {
      const ctx = ctxFrom(program);
      const { vault } = userVault(ctx);
      if (opts.targetPath && !opts.path) {
        throw new Error("--target-path requires --path");
      }
      const plan = await vault.history.rollbackPreview(hash, {
        path: opts.path,
        targetPath: opts.targetPath,
      });
      out(ctx, plan, () => {
        printTable(plan.changes.map((c) => [c.action, c.path]));
        for (const b of plan.unrecoverableBinaries) {
          process.stderr.write(`unrecoverable binary: ${b.path} (${b.hash})\n`);
        }
      });
      const target = opts.path ?? "vault";
      const proceed =
        opts.yes || (await confirm(`Roll back ${target} to ${plan.targetCommit}?`, false));
      if (!proceed) {
        process.stderr.write("aborted\n");
        return;
      }
      const result = await vault.history.rollback(hash, {
        path: opts.path,
        targetPath: opts.targetPath,
      });
      out(ctx, result, () => {
        process.stdout.write(
          `rolled back: ${result.applied} applied, ${result.deleted} deleted, ${result.blobsRestored} blob(s) restored\n`,
        );
      });
      process.stderr.write("run `rtmd pull --theirs` to update this folder\n");
    });
}
