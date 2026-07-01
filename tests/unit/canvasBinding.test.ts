import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { CanvasBinding } from "../../src/editor/CanvasBinding";

describe("CanvasBinding startup", () => {
  it("does not import CRDT data into an open canvas before the document is ready", () => {
    const host = document.createElement("div");
    const originalRequestSave = vi.fn();
    const canvas = {
      getData: vi.fn(() => ({
        nodes: [{ id: "disk", type: "text", text: "from disk" }],
        edges: [],
      })),
      importData: vi.fn(),
      requestFrame: vi.fn(),
      requestSave: originalRequestSave,
    };
    const workspace = {
      iterateAllLeaves: (cb: (leaf: unknown) => void) =>
        cb({
          view: {
            getViewType: () => "canvas",
            file: { path: "Board.canvas" },
            canvas,
            containerEl: host,
          },
        }),
      getLeavesOfType: () => [],
    };
    const awareness = new Awareness(new Y.Doc());
    let ready = false;
    const doc = {
      path: "Board.canvas",
      awareness,
      isReady: () => ready,
      canvasData: () => ({ nodes: [], edges: [] }),
      reconcileFromCanvasData: vi.fn(),
    };

    const binding = new CanvasBinding({ app: { workspace } } as any, doc as any);
    binding.tryBind();

    expect(canvas.importData).not.toHaveBeenCalled();
    expect(originalRequestSave).not.toHaveBeenCalled();

    canvas.requestSave();

    expect(originalRequestSave).toHaveBeenCalledTimes(1);
    expect(doc.reconcileFromCanvasData).not.toHaveBeenCalled();

    ready = true;
    binding.applyRemote();

    expect(canvas.importData).toHaveBeenCalledWith({ nodes: [], edges: [] }, true);
    expect(originalRequestSave).toHaveBeenCalledTimes(2);

    binding.destroy();
    awareness.destroy();
  });
});
