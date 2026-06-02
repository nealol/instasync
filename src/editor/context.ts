import type { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type InstaSyncPlugin from "../main";
import type { Document } from "../Document";

export function getPlugin(editor: EditorView): InstaSyncPlugin | null {
	const info = editor.state.field(editorInfoField, false);
	// app is attached to the editor info in Obsidian.
	const app = (info as any)?.app;
	return app?.plugins?.plugins?.["instasync"] ?? null;
}

export function getDocumentForEditor(editor: EditorView): Document | null {
	const info = editor.state.field(editorInfoField, false);
	const file = info?.file;
	if (!file) return null;
	const plugin = getPlugin(editor);
	if (!plugin || !plugin.vaultSync) return null;
	return plugin.vaultSync.getDocumentForPath(file.path) ?? null;
}
