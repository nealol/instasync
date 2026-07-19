import { describe, expect, it, vi } from "vitest";
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
});
