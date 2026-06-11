/** Output helpers: `--json` switching, aligned tables, error rendering. */

export interface OutputOptions {
	json: boolean;
}

export function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Print rows as aligned columns; `headers` are underlined when given. */
export function printTable(rows: string[][], headers?: string[]): void {
	const all = headers ? [headers, ...rows] : rows;
	if (all.length === 0) return;
	const widths: number[] = [];
	for (const row of all) {
		row.forEach((cell, i) => {
			widths[i] = Math.max(widths[i] ?? 0, cell.length);
		});
	}
	const fmt = (row: string[]) =>
		row
			.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i])))
			.join("  ")
			.trimEnd();
	if (headers) {
		process.stdout.write(`${fmt(headers)}\n`);
		process.stdout.write(`${fmt(widths.map((w) => "-".repeat(w)))}\n`);
	}
	for (const row of headers ? all.slice(1) : all) process.stdout.write(`${fmt(row)}\n`);
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = n;
	let unit = "B";
	for (const u of units) {
		if (value < 1024) break;
		value /= 1024;
		unit = u;
	}
	return `${value.toFixed(1)} ${unit}`;
}

export function formatTime(epochMs: number): string {
	return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19);
}
