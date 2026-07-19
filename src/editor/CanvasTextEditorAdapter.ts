import type { TextEditorAdapter } from "./YTextEditorBinding";
import type { EditorView } from "@codemirror/view";

export interface ActiveCanvasTextEditor {
  nodeId: string;
  editor: TextEditorAdapter;
  source: object;
  view: EditorView | null;
}

/** Isolates feature detection for Obsidian's private Canvas text editor shapes. */
export function discoverCanvasTextEditor(canvas: unknown): ActiveCanvasTextEditor | null {
  if (!canvas || typeof canvas !== "object") return null;
  const value = canvas as any;
  let active: any;
  try {
    active = value.getActiveEditor?.() ?? value.activeEditor ?? value.editingNode ?? null;
  } catch {
    return null;
  }
  if (!active) return null;
  const nodeId = active.nodeId ?? active.node?.id ?? active.canvasNode?.id;
  const editor = active.editor ?? active;
  if (typeof nodeId !== "string" || !nodeId) return null;

  if (
    typeof editor.getValue === "function" &&
    typeof editor.replaceRange === "function" &&
    typeof editor.offsetToPos === "function" &&
    typeof editor.on === "function" &&
    typeof editor.off === "function"
  ) {
    return {
      nodeId,
      source: editor,
      view: findEditorView(editor),
      editor: {
        getText: () => editor.getValue(),
        applyText: (text) => applyMinimalEditorChange(editor, text),
        onChange: (listener) => {
          editor.on("change", listener);
          return () => editor.off("change", listener);
        },
      },
    };
  }

  const view = editor.cm ?? editor.editorView ?? editor.view;
  if (
    view?.state?.doc &&
    typeof view.state.doc.toString === "function" &&
    typeof view.dispatch === "function" &&
    typeof editor.onChange === "function" &&
    typeof editor.offChange === "function"
  ) {
    return {
      nodeId,
      source: editor,
      view,
      editor: {
        getText: () => view.state.doc.toString(),
        applyText: (text) =>
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
        onChange: (listener) => {
          editor.onChange(listener);
          return () => editor.offChange(listener);
        },
      },
    };
  }
  return null;
}

function findEditorView(editor: any): EditorView | null {
  const view = editor?.cm ?? editor?.editorView ?? editor?.view;
  return view?.state?.doc && typeof view.dispatch === "function" ? view : null;
}

function applyMinimalEditorChange(editor: any, target: string): void {
  const current = editor.getValue();
  if (current === target) return;
  let start = 0;
  const max = Math.min(current.length, target.length);
  while (start < max && current[start] === target[start]) start++;
  let currentEnd = current.length;
  let targetEnd = target.length;
  while (
    currentEnd > start &&
    targetEnd > start &&
    current[currentEnd - 1] === target[targetEnd - 1]
  ) {
    currentEnd--;
    targetEnd--;
  }
  editor.replaceRange(
    target.slice(start, targetEnd),
    editor.offsetToPos(start),
    editor.offsetToPos(currentEnd),
  );
}
