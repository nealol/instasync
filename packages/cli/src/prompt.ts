/** Interactive prompts (readline). All throw CliError when stdin is not a TTY. */

import * as readline from "node:readline/promises";
import { CliError } from "./config";

async function withReadline<T>(fn: (rl: readline.Interface) => Promise<T>): Promise<T> {
	if (!process.stdin.isTTY) {
		throw new CliError("interactive prompt needed but stdin is not a TTY (pass the value via flags)");
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	try {
		return await fn(rl);
	} finally {
		rl.close();
	}
}

export function ask(question: string, defaultValue?: string): Promise<string> {
	return withReadline(async (rl) => {
		const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : "";
		const answer = (await rl.question(`${question}${suffix}: `)).trim();
		return answer === "" && defaultValue !== undefined ? defaultValue : answer;
	});
}

export function confirm(question: string, defaultYes = true): Promise<boolean> {
	return withReadline(async (rl) => {
		const answer = (await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
		if (answer === "") return defaultYes;
		return answer === "y" || answer === "yes";
	});
}

/** Numbered picker; returns the chosen item. */
export function pick<T>(question: string, items: T[], label: (item: T) => string): Promise<T> {
	if (items.length === 0) throw new CliError("nothing to choose from");
	if (items.length === 1) return Promise.resolve(items[0]);
	return withReadline(async (rl) => {
		items.forEach((item, i) => process.stderr.write(`  ${i + 1}) ${label(item)}\n`));
		for (;;) {
			const answer = (await rl.question(`${question} [1-${items.length}]: `)).trim();
			const n = Number(answer);
			if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
			process.stderr.write("invalid choice\n");
		}
	});
}
