import type { Command } from "commander";
import { ctxFrom, out, userVault } from "../context";
import { formatTime, printTable } from "../output";

export function registerCursorCommands(program: Command): void {
  const cursor = program
    .command("cursor")
    .description("manage remote cursors (user login required)");

  cursor
    .command("list")
    .description("list this vault's remote cursors")
    .action(async () => {
      const ctx = ctxFrom(program);
      const { vault } = userVault(ctx);
      const cursors = await vault.cursors.list();
      out(ctx, cursors, () =>
        printTable(
          cursors.map((c) => [
            c.id,
            c.name,
            c.pluginId ? `plugin:${c.pluginId}` : "admin",
            formatTime(c.createdAt),
          ]),
          ["id", "name", "kind", "created"],
        ),
      );
    });

  cursor
    .command("create <name>")
    .description("create a remote cursor (prints the secret token once)")
    .action(async (name: string) => {
      const ctx = ctxFrom(program);
      const { vault } = userVault(ctx);
      const created = await vault.cursors.create(name);
      out(ctx, created, () => {
        process.stdout.write(`created cursor "${created.name}" (${created.id})\n`);
        process.stdout.write(`mcp url: ${created.mcpUrl}\n`);
        process.stdout.write(`secret token (shown once, store it now):\n${created.secretToken}\n`);
      });
    });

  cursor
    .command("rename <id> <name>")
    .description("rename a remote cursor")
    .action(async (id: string, name: string) => {
      const ctx = ctxFrom(program);
      const { vault } = userVault(ctx);
      const info = await vault.cursors.rename(id, name);
      out(ctx, info, () => process.stdout.write(`renamed to "${info.name}"\n`));
    });

  cursor
    .command("rm <id>")
    .description("delete a remote cursor (its tokens stop working)")
    .action(async (id: string) => {
      const ctx = ctxFrom(program);
      const { vault } = userVault(ctx);
      await vault.cursors.delete(id);
      process.stderr.write(`deleted cursor ${id}\n`);
    });

  cursor
    .command("token <id>")
    .description("regenerate a cursor's secret token (prints it once)")
    .action(async (id: string) => {
      const ctx = ctxFrom(program);
      const { vault } = userVault(ctx);
      const res = await vault.cursors.regenerateToken(id);
      out(ctx, res, () => {
        process.stdout.write(
          `new secret token (shown once, the old one is dead):\n${res.secretToken}\n`,
        );
      });
    });

  cursor
    .command("audit <id>")
    .description("show a cursor's audit log (newest first)")
    .option("--limit <n>", "max entries", (v) => parseInt(v, 10), 20)
    .option("--before <ms>", "page: entries before this timestamp", (v) => parseInt(v, 10))
    .action(async (id: string, opts: { limit: number; before?: number }) => {
      const ctx = ctxFrom(program);
      const { vault } = userVault(ctx);
      const page = await vault.cursors.audit(id).list({ limit: opts.limit, before: opts.before });
      out(ctx, page, () => {
        printTable(
          page.entries.map((e) => [
            e.id,
            formatTime(e.createdAt),
            e.operation,
            e.toPath ? `${e.path} → ${e.toPath}` : e.path,
            e.undoneAt ? "undone" : "",
          ]),
          ["id", "time", "op", "path", ""],
        );
        if (page.hasMore && page.entries.length > 0) {
          process.stdout.write(
            `…more: --before ${page.entries[page.entries.length - 1].createdAt}\n`,
          );
        }
      });
    });

  cursor
    .command("undo <id> <entryId>")
    .description("revert one audited cursor mutation")
    .option("--force", "override conflict detection")
    .action(async (id: string, entryId: string, opts: { force?: boolean }) => {
      const ctx = ctxFrom(program);
      const { vault } = userVault(ctx);
      await vault.cursors.audit(id).undo(entryId, { force: opts.force });
      process.stderr.write(`undid audit entry ${entryId}\n`);
    });
}
