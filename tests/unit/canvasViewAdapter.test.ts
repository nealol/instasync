import { describe, expect, it, vi } from "vitest";
import { normalizeCanvas } from "../../src/structured/canvasOperations";
import { CanvasViewAdapter } from "../../src/editor/CanvasViewAdapter";

function item(data: Record<string, unknown>) {
  return { setData: vi.fn(), data };
}

function fixture() {
  const nodeA = item({ id: "a", type: "text", text: "old", x: 0, y: 0, color: "1" });
  const nodeB = item({ id: "b", type: "text", text: "b", x: 10, y: 0 });
  const edge = item({ id: "e", fromNode: "a", toNode: "b" });
  const canvas = {
    getData: vi.fn(),
    nodes: new Map([
      ["a", nodeA],
      ["b", nodeB],
    ]),
    edges: new Map([["e", edge]]),
    selection: new Set<unknown>([nodeA]),
    tx: 12,
    ty: 24,
    tZoom: 2,
    interactionState: { dragging: true },
    addNode: vi.fn(),
    addEdge: vi.fn(),
    removeNode: vi.fn(),
    removeEdge: vi.fn(),
    requestFrame: vi.fn(),
  };
  return { canvas, nodeA, nodeB, edge, adapter: new CanvasViewAdapter(canvas) };
}

const current = normalizeCanvas({
  nodes: [
    { id: "a", type: "text", text: "old", x: 0, y: 0, color: "1" },
    { id: "b", type: "text", text: "b", x: 10, y: 0 },
  ],
  edges: [{ id: "e", fromNode: "a", toNode: "b" }],
});

describe("CanvasViewAdapter", () => {
  it("applies movement and text/style patches without disturbing selection or viewport", () => {
    const { adapter, canvas, nodeA } = fixture();
    const result = adapter.apply(
      [
        {
          type: "node-patch",
          id: "a",
          patch: { set: { x: 50, text: "new", color: "3" }, remove: [] },
        },
      ],
      current,
    );

    expect(result).toEqual({ applied: true });
    expect(nodeA.setData).toHaveBeenCalledWith({
      id: "a",
      type: "text",
      text: "new",
      x: 50,
      y: 0,
      color: "3",
    });
    expect([...canvas.selection]).toEqual([nodeA]);
    expect([canvas.tx, canvas.ty, canvas.tZoom]).toEqual([12, 24, 2]);
    expect(canvas.requestFrame).toHaveBeenCalledOnce();
  });

  it("applies node and edge create/delete in one batch", () => {
    const { adapter, canvas, nodeB, edge } = fixture();
    const newNode = { id: "c", type: "text", text: "c", x: 20, y: 0 };
    const newEdge = { id: "f", fromNode: "a", toNode: "c" };
    const result = adapter.apply(
      [
        { type: "node-create", node: newNode },
        { type: "edge-create", edge: newEdge },
        { type: "edge-delete", id: "e" },
        { type: "node-delete", id: "b" },
      ],
      current,
    );

    expect(result.applied).toBe(true);
    expect(canvas.addNode).toHaveBeenCalledWith(newNode);
    expect(canvas.addEdge).toHaveBeenCalledWith(newEdge);
    expect(canvas.removeEdge).toHaveBeenCalledWith(edge);
    expect(canvas.removeNode).toHaveBeenCalledWith(nodeB);
  });

  it("rejects an unsupported mixed batch before applying any operation", () => {
    const { adapter, nodeA } = fixture();
    const result = adapter.apply(
      [
        { type: "node-patch", id: "a", patch: { set: { x: 1 }, remove: [] } },
        { type: "node-order", order: ["b", "a"] },
      ],
      current,
    );

    expect(result).toEqual({ applied: false, reason: "unsupported" });
    expect(nodeA.setData).not.toHaveBeenCalled();
  });

  it("reports thrown private API calls so the binding can perform one full import", () => {
    const { adapter, nodeA } = fixture();
    nodeA.setData.mockImplementation(() => {
      throw new TypeError("changed API");
    });
    const result = adapter.apply(
      [{ type: "node-patch", id: "a", patch: { set: { x: 1 }, remove: [] } }],
      current,
    );

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("exception");
    expect(result.error).toBeInstanceOf(TypeError);
  });

  it("feature-detects changed collection and item API shapes", () => {
    const canvas = { getData: vi.fn(), nodes: {}, edges: {}, addNode: vi.fn() };
    const adapter = new CanvasViewAdapter(canvas);
    expect(
      adapter.apply(
        [{ type: "node-patch", id: "a", patch: { set: { x: 1 }, remove: [] } }],
        current,
      ),
    ).toEqual({ applied: false, reason: "unsupported" });
  });
});
