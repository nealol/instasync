import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

const bind = vi.hoisted(() => ({ doc: null as any }));

vi.mock("../../src/editor/context", () => ({
  ensureDocumentForEditor: () => bind.doc,
}));

import { LiveEditPluginValue } from "../../src/editor/LiveEdit";

function makeEditor(text: string) {
  return {
    state: {
      doc: { toString: () => text },
    },
    setText(next: string) {
      text = next;
    },
    dispatch({ changes }: { changes: { from: number; to: number; insert: string } }) {
      text = text.slice(0, changes.from) + changes.insert + text.slice(changes.to);
    },
  };
}

describe("LiveEdit", () => {
  it("does not push local editor changes until the document is ready, then preserves typed text", async () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("contents");
    ytext.insert(0, "remote ready value");
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let isReady = false;
    bind.doc = {
      path: "note.md",
      ytext,
      bindEditor: vi.fn(),
      unbindEditor: vi.fn(),
      whenReady: () => ready,
      isReady: () => isReady,
      isDestroyed: () => false,
    };

    const editor = makeEditor("remote ready value") as any;
    const live = new LiveEditPluginValue(editor);
    editor.setText("remote ready value plus local typing");

    live.update({ docChanged: true, state: editor.state } as any);
    expect(ytext.toString()).toBe("remote ready value");

    isReady = true;
    resolveReady();
    await Promise.resolve();

    expect(ytext.toString()).toBe("remote ready value plus local typing");
    live.destroy();
    ydoc.destroy();
  });
});
