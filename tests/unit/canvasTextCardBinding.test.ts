import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CanvasTextCardBinding } from "../../src/editor/CanvasTextCardBinding";

function makeEditor(initial: string) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    source: {
      getValue: () => value,
      offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
      replaceRange: (insert: string, from: { ch: number }, to: { ch: number }) => {
        value = value.slice(0, from.ch) + insert + value.slice(to.ch);
      },
      on: (_event: string, listener: () => void) => listeners.add(listener),
      off: (_event: string, listener: () => void) => listeners.delete(listener),
    },
    get value() {
      return value;
    },
    type(next: string) {
      value = next;
      listeners.forEach((listener) => listener());
    },
  };
}

function makeDoc() {
  const ydoc = new Y.Doc();
  const root = ydoc.getMap("root");
  const nodes = new Y.Map();
  const node = new Y.Map();
  const text = new Y.Text();
  root.set("nodes", nodes);
  nodes.set("n1", node);
  node.set("text", text);
  text.insert(0, "shared");
  return {
    text,
    doc: {
      canvasNodeText: (id: string) => (id === "n1" ? text : null),
      whenReady: async () => {},
      isReady: () => true,
      isCreator: false,
      hasSyncedOnce: true,
      isProviderOnline: true,
    },
  };
}

describe("CanvasTextCardBinding", () => {
  it("binds the active node editor and cleans up on close", async () => {
    const { doc, text } = makeDoc();
    const editor = makeEditor("shared");
    let canvas: unknown = { activeEditor: { nodeId: "n1", editor: editor.source } };
    const active = vi.fn();
    const binding = new CanvasTextCardBinding(doc as any, () => canvas, active);
    binding.start();
    await Promise.resolve();
    editor.type("shared locally");
    expect(text.toString()).toBe("shared locally");
    text.insert(text.length, " remote");
    expect(editor.value).toBe("shared locally remote");
    canvas = {};
    binding.refresh();
    expect(active).toHaveBeenLastCalledWith(null);
    binding.destroy();
  });
});
