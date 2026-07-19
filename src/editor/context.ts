import type { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type RealtimePlugin from "../main";
import type { Document } from "../Document";

export function getPlugin(editor: EditorView): RealtimePlugin | null {
  const info = editor.state.field(editorInfoField, false);
  // app is attached to the editor info in Obsidian.
  const app = (info as any)?.app;
  return app?.plugins?.plugins?.["realtime"] ?? null;
}

export function requestSaveForEditor(editor: EditorView): void {
  const info = editor.state.field(editorInfoField, false);
  const file = info?.file;
  const app = (info as any)?.app;
  const workspace = app?.workspace as any;
  if (!file || !workspace) return;

  const views = new Set<any>();
  const collect = (leaf: any): void => {
    const view = leaf?.view;
    if (view?.file?.path === file.path) views.add(view);
  };

  if (typeof workspace.iterateAllLeaves === "function") {
    workspace.iterateAllLeaves(collect);
  }
  if (typeof workspace.getLeavesOfType === "function") {
    for (const leaf of workspace.getLeavesOfType("markdown") ?? []) collect(leaf);
  }

  for (const view of views) {
    if (typeof view.requestSave === "function") {
      view.requestSave();
    } else if (typeof view.save === "function") {
      void Promise.resolve(view.save()).catch((error) => {
        console.error(`[Realtime] editor save failed for ${file.path}`, error);
      });
    }
  }
}

export function getDocumentForEditor(editor: EditorView): Document | null {
  const info = editor.state.field(editorInfoField, false);
  const file = info?.file;
  if (!file) return null;
  const plugin = getPlugin(editor);
  if (!plugin || !plugin.vaultSync) return null;
  return plugin.vaultSync.getDocumentForPath(file.path) ?? null;
}

export function ensureDocumentForEditor(editor: EditorView): Document | null {
  const info = editor.state.field(editorInfoField, false);
  const file = info?.file;
  if (!file) return null;
  const plugin = getPlugin(editor);
  if (!plugin || !plugin.vaultSync) return null;
  return plugin.vaultSync.ensureDocumentForPath(file.path) ?? null;
}
