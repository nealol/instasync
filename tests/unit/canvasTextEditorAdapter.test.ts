import { describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { discoverCanvasTextEditor } from "../../src/editor/CanvasTextEditorAdapter";

describe("discoverCanvasTextEditor", () => {
  it("adapts an active Canvas editor with cleanup", () => {
    let value = "hello";
    const listeners = new Set<() => void>();
    const internal = {
      getValue: () => value,
      offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
      replaceRange: vi.fn((insert: string, from: { ch: number }, to: { ch: number }) => {
        value = value.slice(0, from.ch) + insert + value.slice(to.ch);
      }),
      on: (_event: string, listener: () => void) => listeners.add(listener),
      off: (_event: string, listener: () => void) => listeners.delete(listener),
    };
    const active = discoverCanvasTextEditor({ activeEditor: { nodeId: "n1", editor: internal } });
    expect(active?.nodeId).toBe("n1");
    expect(active?.editor.getText()).toBe("hello");
    active?.editor.applyText("hello world");
    expect(internal.replaceRange).toHaveBeenCalledWith(
      " world",
      { line: 0, ch: 5 },
      { line: 0, ch: 5 },
    );
    const changed = vi.fn();
    const cleanup = active!.editor.onChange(changed);
    listeners.forEach((listener) => listener());
    expect(changed).toHaveBeenCalledOnce();
    cleanup();
    expect(listeners.size).toBe(0);
  });

  it("rejects unsupported editors so snapshot capture remains active", () => {
    expect(discoverCanvasTextEditor({ activeEditor: { nodeId: "n1", editor: {} } })).toBeNull();
    expect(discoverCanvasTextEditor({})).toBeNull();
  });

  it("adapts Obsidian's editing Canvas node and embedded CodeMirror view", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ doc: "hello", parent });
    const originalSave = vi.fn();
    const child = {
      dirty: true,
      editor: {},
      editMode: { cm: view },
      save: originalSave,
    };
    const node = { id: "n1", isEditing: true, child };
    const active = discoverCanvasTextEditor({ nodes: new Map([["n1", node]]) });

    expect(active?.nodeId).toBe("n1");
    expect(active?.view).toBe(view);
    expect(active?.editor.hasLocalChanges?.()).toBe(true);

    const changed = vi.fn();
    const cleanup = active?.editor.onChange(changed);
    view.dispatch({ changes: { from: 5, insert: " world" } });
    child.save(view.state.doc.toString());
    expect(changed).toHaveBeenCalledTimes(1);
    expect(active?.editor.getText()).toBe("hello world");

    active?.editor.applyText("hello realtime");
    expect(view.state.doc.toString()).toBe("hello realtime");
    cleanup?.();
    child.save(view.state.doc.toString());
    expect(changed).toHaveBeenCalledTimes(1);
    expect(originalSave).toHaveBeenCalledTimes(2);
    view.destroy();
    parent.remove();
  });
});
