import picomatch from "picomatch";

/** Parse a comma-separated glob list into trimmed, non-empty patterns. */
export function parseGlobs(list: string): string[] {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** True if `path` matches any of the given glob patterns. */
export function matchesAnyGlob(path: string, globs: string[]): boolean {
  let matched = false;
  for (const glob of globs) {
    const negated = glob.startsWith("!");
    const pattern = negated ? glob.slice(1) : glob;
    if (!pattern) continue;
    if (picomatch.isMatch(path, pattern, { dot: true })) matched = !negated;
  }
  return matched;
}
