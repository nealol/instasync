import { App, TFile } from "obsidian";

/**
 * Helpers shared between the text ({@link Document}) and binary ({@link BinarySync})
 * sync paths. Both must create parent folders before writing a file, and both must
 * avoid overwriting a file that is currently open in the workspace: a `vault.modify`
 * / `vault.modifyBinary` on an open file surfaces to Obsidian as an *external*
 * change, which it then 3-way-merges into the open view — duplicating text in the
 * editor case, and needlessly thrashing the view in the binary case.
 */

/** Create the parent folder chain for `path` if it doesn't exist yet. */
export async function ensureParentFolder(app: App, path: string): Promise<void> {
	const slash = path.lastIndexOf("/");
	if (slash <= 0) return;
	const folder = path.slice(0, slash);
	let current = "";
	for (const part of folder.split("/")) {
		if (!part) continue;
		current = current ? `${current}/${part}` : part;
		if (app.vault.getAbstractFileByPath(current)) continue;
		try {
			await app.vault.createFolder(current);
		} catch (e) {
			// Folder may have been created concurrently; ignore.
		}
	}
}

/** True if the file at `path` is open in any workspace leaf (or is active). */
export function isOpenInWorkspace(app: App, path: string): boolean {
	const workspace = app.workspace as any;
	if (workspace?.getActiveFile?.()?.path === path) return true;

	let found = false;
	workspace?.iterateAllLeaves?.((leaf: any) => {
		if (leaf?.view?.file?.path === path) found = true;
	});
	if (found) return true;

	const leaves = workspace?.getLeavesOfType?.("markdown") ?? [];
	return leaves.some((leaf: any) => leaf?.view?.file?.path === path);
}

/** Resolve a vault-relative path to a {@link TFile}, or null if absent / a folder. */
export function getFileByPath(app: App, path: string): TFile | null {
	const af = app.vault.getAbstractFileByPath(path);
	return af instanceof TFile ? af : null;
}
