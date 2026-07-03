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

/**
 * Obsidian reuses the same view (and Canvas instance) when a leaf switches to
 * another canvas file. A binding patched before the switch must neither fold
 * the other file's data into its CRDT nor import its CRDT into the other
 * file's view. Regression suite for the cross-file overwrite hazard.
 */
describe("CanvasBinding reused view (file switch)", () => {
  function makeCanvas(data: () => unknown) {
    return {
      getData: vi.fn(data),
      importData: vi.fn(),
      requestFrame: vi.fn(),
      requestSave: vi.fn(),
    };
  }

  function makeDoc(path: string, ready = true) {
    return {
      path,
      awareness: new Awareness(new Y.Doc()),
      isReady: () => ready,
      canvasData: () => ({ nodes: [{ id: "a", type: "text", text: "A" }], edges: [] }),
      reconcileFromCanvasData: vi.fn(),
    };
  }

  function makeWorkspace(view: any) {
    return {
      iterateAllLeaves: (cb: (leaf: unknown) => void) => cb({ view }),
      getLeavesOfType: () => [],
    };
  }

  it("does not capture the other file's data after the view switches files", () => {
    const canvas = makeCanvas(() => ({
      nodes: [{ id: "b", type: "text", text: "content of B" }],
      edges: [],
    }));
    const view = {
      getViewType: () => "canvas",
      file: { path: "A.canvas" },
      canvas,
      containerEl: document.createElement("div"),
    };
    const doc = makeDoc("A.canvas");
    const binding = new CanvasBinding(
      { app: { workspace: makeWorkspace(view) } } as any,
      doc as any,
    );
    binding.tryBind();
    doc.reconcileFromCanvasData.mockClear();

    // The leaf switches the reused view to another file.
    view.file = { path: "B.canvas" };
    canvas.getData.mockClear();

    // A local edit in B fires the still-patched requestSave.
    (canvas.requestSave as any)();

    // B's data must NOT be folded into A's CRDT, and the binding must detach.
    expect(doc.reconcileFromCanvasData).not.toHaveBeenCalled();
    expect(binding.isActive()).toBe(false);

    binding.destroy();
    doc.awareness.destroy();
  });

  it("does not import its CRDT into a view that now shows another file", () => {
    const canvas = makeCanvas(() => ({ nodes: [], edges: [] }));
    const view = {
      getViewType: () => "canvas",
      file: { path: "A.canvas" },
      canvas,
      containerEl: document.createElement("div"),
    };
    const doc = makeDoc("A.canvas");
    const binding = new CanvasBinding(
      { app: { workspace: makeWorkspace(view) } } as any,
      doc as any,
    );
    binding.tryBind();
    canvas.importData.mockClear();

    view.file = { path: "B.canvas" };

    // A remote update to A arrives while the view shows B.
    binding.applyRemote();

    // A's content must NOT be imported into (and saved over) B's view.
    expect(canvas.importData).not.toHaveBeenCalled();
    expect(binding.isActive()).toBe(false);

    binding.destroy();
    doc.awareness.destroy();
  });

  it("keeps the new file's binding working when the old binding unpatches later", () => {
    const canvas = makeCanvas(() => ({
      nodes: [{ id: "b", type: "text", text: "content of B" }],
      edges: [],
    }));
    const view = {
      getViewType: () => "canvas",
      file: { path: "A.canvas" },
      canvas,
      containerEl: document.createElement("div"),
    };
    const workspace = makeWorkspace(view);
    const docA = makeDoc("A.canvas");
    const bindingA = new CanvasBinding({ app: { workspace } } as any, docA as any);
    bindingA.tryBind();

    // Switch to B and bind B's doc BEFORE A is unbound (wraps A's patch).
    view.file = { path: "B.canvas" };
    const docB = makeDoc("B.canvas");
    const bindingB = new CanvasBinding({ app: { workspace } } as any, docB as any);
    bindingB.tryBind();

    // A's late unbind must not clobber B's patch.
    bindingA.unbindIfStale();
    expect(bindingA.isActive()).toBe(false);
    expect(bindingB.isActive()).toBe(true);

    docB.reconcileFromCanvasData.mockClear();
    docA.reconcileFromCanvasData.mockClear();
    (canvas.requestSave as any)();

    expect(docB.reconcileFromCanvasData).toHaveBeenCalled();
    expect(docA.reconcileFromCanvasData).not.toHaveBeenCalled();

    bindingA.destroy();
    bindingB.destroy();
    docA.awareness.destroy();
    docB.awareness.destroy();
  });
});
