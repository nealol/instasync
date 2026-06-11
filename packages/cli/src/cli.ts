import { Command } from "commander";
import { ApiError } from "@realtime-md/sdk";
import { CliError } from "./config";
import { registerAuthCommands } from "./commands/auth";
import { registerWorkspaceCommands } from "./commands/workspace";
import { registerFileCommands } from "./commands/files";
import { registerSearchCommands } from "./commands/search";
import { registerHistoryCommands } from "./commands/history";
import { registerCursorCommands } from "./commands/cursor";
import { registerAdminCommands } from "./commands/admin";
import { registerAttachCommands } from "./commands/attach";

const program = new Command("rtmd")
	.description("Command-line client for a Realtime.md server")
	.option("--dir <path>", "operate on this folder instead of the working directory")
	.option("--json", "machine-readable JSON output")
	.configureHelp({ sortSubcommands: true });

registerAuthCommands(program);
registerWorkspaceCommands(program);
registerFileCommands(program);
registerSearchCommands(program);
registerHistoryCommands(program);
registerCursorCommands(program);
registerAdminCommands(program);
registerAttachCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
	if (err instanceof CliError) {
		process.stderr.write(`rtmd: ${err.message}\n`);
	} else if (err instanceof ApiError) {
		process.stderr.write(`rtmd: server error: ${err.message}\n`);
	} else {
		process.stderr.write(`rtmd: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	}
	process.exitCode = 1;
});
