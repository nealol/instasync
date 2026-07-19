import type { TextEditorAdapter } from "./YTextEditorBinding";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

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
  if (!active) active = discoverEditingNode(value.nodes);
  if (!active) return null;
  const nodeId = active.nodeId ?? active.node?.id ?? active.canvasNode?.id;
  const child = active.child ?? active.node?.child ?? active.canvasNode?.child;
  const editor = active.editor ?? child?.editor ?? child ?? active;
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
        hasLocalChanges: () => child?.dirty === true,
        onChange: (listener) => {
          editor.on("change", listener);
          return () => editor.off("change", listener);
        },
      },
    };
  }

  const view = findEditorView(editor) ?? findEditorView(child?.editMode);
  if (view) {
    return {
      nodeId,
      source: view,
      view,
      editor: {
        getText: () => view.state.doc.toString(),
        applyText: (text) => applyMinimalViewChange(view, text),
        hasLocalChanges: () => child?.dirty === true,
        onChange: (listener) =>
          typeof child?.save === "function"
            ? mountSaveListener(child, listener)
            : mountViewChangeListener(view, listener),
      },
    };
  }
  return null;
}

function findEditorView(editor: any): EditorView | null {
  const view =
    editor?.state?.doc && typeof editor.dispatch === "function"
      ? editor
      : (editor?.cm ?? editor?.editorView ?? editor?.view);
  return view?.state?.doc && typeof view.dispatch === "function" ? view : null;
}

function discoverEditingNode(nodes: unknown): any | null {
  if (nodes instanceof Map) {
    for (const node of nodes.values()) {
      if (node?.isEditing === true && node.child)
        return { nodeId: node.id, node, child: node.child };
    }
    return null;
  }
  const values =
    nodes && typeof nodes === "object" && "values" in nodes
      ? (nodes as { values?: unknown }).values
      : null;
  if (typeof values === "function") {
    try {
      for (const node of values.call(nodes) as Iterable<any>) {
        if (node?.isEditing === true && node.child)
          return { nodeId: node.id, node, child: node.child };
      }
    } catch {
      return null;
    }
  }
  if (nodes && typeof nodes === "object") {
    for (const node of Object.values(nodes as Record<string, unknown>)) {
      if ((node as any)?.isEditing === true && (node as any).child) {
        return { nodeId: (node as any).id, node, child: (node as any).child };
      }
    }
  }
  return null;
}

function mountSaveListener(child: any, listener: () => void): () => void {
  const original = child.save;
  let active = true;
  const patched = function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    if (active) listener();
    return result;
  };
  child.save = patched;
  return () => {
    active = false;
    if (child.save === patched) child.save = original;
  };
}

function mountViewChangeListener(view: EditorView, listener: () => void): () => void {
  const compartment = new Compartment();
  const extension = EditorView.updateListener.of((update) => {
    if (update.docChanged) listener();
  });
  view.dispatch({ effects: StateEffect.appendConfig.of(compartment.of(extension)) });
  return () => {
    try {
      view.dispatch({ effects: compartment.reconfigure([]) });
    } catch {
      // The Canvas editor can be destroyed before its polling binding detaches.
    }
  };
}

function applyMinimalViewChange(view: EditorView, target: string): void {
  const current = view.state.doc.toString();
  if (current === target) return;
  const change = minimalChange(current, target);
  view.dispatch({ changes: change });
}

function applyMinimalEditorChange(editor: any, target: string): void {
  const current = editor.getValue();
  if (current === target) return;
  const change = minimalChange(current, target);
  editor.replaceRange(
    change.insert,
    editor.offsetToPos(change.from),
    editor.offsetToPos(change.to),
  );
}

function minimalChange(
  current: string,
  target: string,
): {
  from: number;
  to: number;
  insert: string;
} {
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
  return { from: start, to: currentEnd, insert: target.slice(start, targetEnd) };
}
