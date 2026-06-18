/**
 * Lightweight, opt-in debug logging for diagnosing sync issues. Hidden and off
 * by default; the advanced settings toggle updates this module-level flag.
 */
let enabled = false;

export function setDiagnosticLoggingEnabled(value: boolean): void {
  enabled = value;
}

export function dbgEnabled(): boolean {
  return enabled;
}

export function dbg(...args: unknown[]): void {
  if (dbgEnabled()) console.log("%c[IS]", "color:#30bced", ...args);
}

/** Truncate long strings for readable logs, showing length. */
export function snip(s: string | null, n = 60): string {
  if (s === null) return "<null>";
  const oneLine = s.replace(/\n/g, "⏎");
  return oneLine.length <= n
    ? `"${oneLine}"(${s.length})`
    : `"${oneLine.slice(0, n)}…"(${s.length})`;
}
