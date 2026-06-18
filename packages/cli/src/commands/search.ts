import type { Command } from "commander";
import { ctxFrom, out, vaultClients } from "../context";
import { printTable } from "../output";

export function registerSearchCommands(program: Command): void {
  program
    .command("search <query>")
    .description("full-text search across the vault")
    .option("--limit <n>", "max results", (v) => parseInt(v, 10))
    .action(async (query: string, opts: { limit?: number }) => {
      const ctx = ctxFrom(program);
      const { vault } = vaultClients(ctx);
      const hits = await vault.search.search(query, { limit: opts.limit });
      out(ctx, hits, () => {
        for (const h of hits) {
          process.stdout.write(`${h.path}\n  ${h.snippet.replace(/\s+/g, " ").trim()}\n`);
        }
        process.stdout.write(`${hits.length} result(s)\n`);
      });
    });

  program
    .command("tags")
    .description("list tags and counts")
    .action(async () => {
      const ctx = ctxFrom(program);
      const { vault } = vaultClients(ctx);
      const tags = await vault.search.tags();
      out(ctx, tags, () =>
        printTable(
          tags.map((t) => [String(t.count), t.tag]),
          ["count", "tag"],
        ),
      );
    });

  program
    .command("backlinks <path>")
    .description("list notes linking to a path")
    .action(async (relPath: string) => {
      const ctx = ctxFrom(program);
      const { vault } = vaultClients(ctx);
      const hits = await vault.search.backlinks(relPath);
      out(ctx, hits, () => {
        for (const h of hits) process.stdout.write(`${h.path}\n`);
        process.stdout.write(`${hits.length} backlink(s)\n`);
      });
    });

  program
    .command("reindex")
    .description("rebuild the server's search index")
    .action(async () => {
      const ctx = ctxFrom(program);
      const { vault } = vaultClients(ctx);
      const res = await vault.search.reindex();
      out(ctx, res, () => process.stdout.write(`reindexed ${res.count} note(s)\n`));
    });
}
