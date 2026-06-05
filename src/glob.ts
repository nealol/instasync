/**
 * Minimal glob matching for the binary-file exclude setting. Supports `*` (any
 * run of non-separator chars), `**` (any run including separators), and `?` (a
 * single non-separator char). Patterns are matched against the full
 * vault-relative path. Everything else is treated literally.
 */

function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*"; // ** — crosses path separators
				i++;
			} else {
				re += "[^/]*"; // * — within a single path segment
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

/** Parse a comma-separated glob list into trimmed, non-empty patterns. */
export function parseGlobs(list: string): string[] {
	return list
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** True if `path` matches any of the given glob patterns. */
export function matchesAnyGlob(path: string, globs: string[]): boolean {
	return globs.some((g) => globToRegExp(g).test(path));
}
