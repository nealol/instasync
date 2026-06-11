/** Path → server resource routing and sync exclusion rules. */

import type { FileKind } from "./config";

export function kindForPath(relPath: string): FileKind {
	const lower = relPath.toLowerCase();
	if (lower.endsWith(".md")) return "note";
	if (lower.endsWith(".canvas")) return "canvas";
	if (lower.endsWith(".base")) return "base";
	return "attachment";
}

/**
 * True when a vault-relative path must never sync: the `.rtmd` file itself and
 * anything inside a dot-directory or named with a leading dot (`.git`,
 * `.obsidian`, editor droppings).
 */
export function isExcluded(relPath: string): boolean {
	return relPath.split("/").some((seg) => seg.startsWith("."));
}
