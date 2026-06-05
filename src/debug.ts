/**
 * Lightweight, opt-in debug logging for diagnosing sync issues.
 *
 * Enable from the Obsidian devtools console with:
 *   window.INSTASYNC_DEBUG = true
 * (or `localStorage.INSTASYNC_DEBUG = "1"` to persist across reloads), then
 * reproduce the problem. Disable with `window.INSTASYNC_DEBUG = false`.
 */
export function dbgEnabled(): boolean {
	const w = window as any;
	if (w.INSTASYNC_DEBUG !== undefined) return !!w.INSTASYNC_DEBUG;
	try {
		return localStorage.getItem("INSTASYNC_DEBUG") === "1";
	} catch {
		return false;
	}
}

export function dbg(...args: unknown[]): void {
	if (dbgEnabled()) console.log("%c[IS]", "color:#30bced", ...args);
}

/** Truncate long strings for readable logs, showing length. */
export function snip(s: string | null, n = 60): string {
	if (s === null) return "<null>";
	const oneLine = s.replace(/\n/g, "⏎");
	return oneLine.length <= n ? `"${oneLine}"(${s.length})` : `"${oneLine.slice(0, n)}…"(${s.length})`;
}
