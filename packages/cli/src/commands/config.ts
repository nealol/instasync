import type { Command } from "commander";
import { CliError, writeRtmd } from "../config";
import { filteredSnapshot, parseAttachmentGlobs } from "../attachmentFilter";
import { ctxFrom, out, workspace } from "../context";

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("configure this synced folder");

  config
    .command("attachments [mode]")
    .description("show or change attachment sync (mode: on or off)")
    .option("--include <globs>", "comma-separated include globs; non-matches are ignored")
    .option("--all", "clear the include filter and sync every attachment")
    .action(
      async (
        mode: string | undefined,
        options: { include?: string; all?: boolean },
        command: Command,
      ) => {
        if (mode !== undefined && mode !== "on" && mode !== "off") {
          throw new CliError('attachment sync mode must be "on" or "off"');
        }
        if (options.include !== undefined && options.all) {
          throw new CliError("--include and --all cannot be used together");
        }

        const ctx = ctxFrom(command);
        const ws = workspace(ctx);
        const current = ws.config.attachmentSync ?? { enabled: true, includeGlobs: [] };
        const next = {
          enabled: mode === undefined ? current.enabled : mode === "on",
          includeGlobs:
            options.include !== undefined
              ? parseAttachmentGlobs(options.include)
              : options.all
                ? []
                : current.includeGlobs,
        };

        if (mode !== undefined || options.include !== undefined || options.all) {
          ws.config.attachmentSync = next;
          if (ws.config.sync) {
            ws.config.sync.files = filteredSnapshot(ws.config, ws.config.sync.files);
          }
          writeRtmd(ws.dir, ws.config);
        }

        out(ctx, next, () => {
          process.stdout.write(`attachment sync: ${next.enabled ? "on" : "off"}\n`);
          process.stdout.write(
            `attachment filter: ${next.includeGlobs.length ? next.includeGlobs.join(", ") : "all"}\n`,
          );
        });
      },
    );
}
