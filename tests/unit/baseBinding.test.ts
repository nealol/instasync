import { describe, expect, it, vi } from "vitest";
import { BaseBinding } from "../../src/editor/BaseBinding";

/**
 * Obsidian reuses the same TextFileView when a leaf switches to another
 * `.base` file. A binding patched before the switch must neither fold the
 * other file's YAML into its CRDT nor push its CRDT into the other file's
 * view. Regression suite for the cross-file overwrite hazard (mirrors the
 * CanvasBinding reused-view suite).
 */
describe("BaseBinding reused view (file switch)", () => {
  function makeView(path: string, data: () => string) {
    return {
      getViewType: () => "bases",
      file: { path } as { path: string },
      getViewData: vi.fn(data),
      setViewData: vi.fn(),
      requestSave: vi.fn(),
    };
  }

  function makeDoc(path: string) {
    return {
      path,
      baseData: () => "views:\n  - type: table\n    name: A\n",
      reconcileFromBaseText: vi.fn(),
    };
  }

  function makeWorkspace(view: any) {
    return {
      iterateAllLeaves: (cb: (leaf: unknown) => void) => cb({ view }),
      getLeavesOfType: () => [],
    };
  }

  it("does not capture the other file's YAML after the view switches files", () => {
    const view = makeView("A.base", () => "views:\n  - type: table\n    name: B\n");
    const doc = makeDoc("A.base");
    const binding = new BaseBinding({ app: { workspace: makeWorkspace(view) } } as any, doc as any);
    binding.tryBind();
    doc.reconcileFromBaseText.mockClear();

    // The leaf switches the reused view to another file.
    view.file = { path: "B.base" };

    // A local edit in B fires the still-patched requestSave.
    (view.requestSave as any)();

    expect(doc.reconcileFromBaseText).not.toHaveBeenCalled();
    expect(binding.isActive()).toBe(false);
  });

  it("does not push its CRDT into a view that now shows another file", () => {
    const view = makeView("A.base", () => "");
    const doc = makeDoc("A.base");
    const binding = new BaseBinding({ app: { workspace: makeWorkspace(view) } } as any, doc as any);
    binding.tryBind();
    view.setViewData.mockClear();

    view.file = { path: "B.base" };

    // A remote update to A arrives while the view shows B.
    binding.applyRemote();

    expect(view.setViewData).not.toHaveBeenCalled();
    expect(binding.isActive()).toBe(false);
  });

  it("keeps the new file's binding working when the old binding unpatches later", () => {
    const view = makeView("A.base", () => "views:\n  - type: table\n    name: B\n");
    const workspace = makeWorkspace(view);
    const docA = makeDoc("A.base");
    const bindingA = new BaseBinding({ app: { workspace } } as any, docA as any);
    bindingA.tryBind();

    // Switch to B and bind B's doc BEFORE A is unbound (wraps A's patch).
    view.file = { path: "B.base" };
    const docB = makeDoc("B.base");
    docB.baseData = () => "views:\n  - type: table\n    name: B\n";
    const bindingB = new BaseBinding({ app: { workspace } } as any, docB as any);
    bindingB.tryBind();

    // A's late unbind must not clobber B's patch.
    bindingA.unbindIfStale();
    expect(bindingA.isActive()).toBe(false);
    expect(bindingB.isActive()).toBe(true);

    docA.reconcileFromBaseText.mockClear();
    docB.reconcileFromBaseText.mockClear();
    (view.requestSave as any)();

    expect(docB.reconcileFromBaseText).toHaveBeenCalled();
    expect(docA.reconcileFromBaseText).not.toHaveBeenCalled();
  });
});
