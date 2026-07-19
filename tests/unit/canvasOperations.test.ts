import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { parseCanvas, reconcileCanvas, serializeCanvas } from "../../src/structured/canvas";
import {
  applyCanvasOperations,
  canonicalizeCanvasOrders,
  diffCanvas,
  normalizeCanvas,
  type CanvasOperation,
} from "../../src/structured/canvasOperations";
import { toValue } from "../../src/structured/reconcile";
import { canvasSnapshot, generatedCanvas, makeCanvasClients } from "../support/canvasHarness";

function seededDoc(data: unknown = canvasSnapshot()) {
  const doc = new Y.Doc();
  reconcileCanvas(doc.getMap("root"), parseCanvas(JSON.stringify(data)), doc.clientID);
  return doc;
}

function fileValue(doc: Y.Doc) {
  return JSON.parse(serializeCanvas(toValue(doc.getMap("root"))));
}

describe("Canvas operation diff", () => {
  it("emits only changed geometry fields for a node movement", () => {
    const before = normalizeCanvas(canvasSnapshot());
    const after = normalizeCanvas(
      canvasSnapshot({ nodeOverrides: [{ id: "text", x: 40, y: 70 }] }),
    );
    expect(diffCanvas(before, after)).toEqual([
      { type: "node-patch", id: "text", patch: { set: { x: 40, y: 70 }, remove: [] } },
    ]);
  });

  it("distinguishes changed, removed, and unchanged fields", () => {
    const before = normalizeCanvas(canvasSnapshot());
    const next = canvasSnapshot({
      nodeOverrides: [{ id: "text", width: 300, height: 180, color: "2" }],
    });
    delete (next.nodes[0] as any).custom;
    expect(diffCanvas(before, normalizeCanvas(next))).toEqual([
      {
        type: "node-patch",
        id: "text",
        patch: { set: { color: "2", height: 180, width: 300 }, remove: ["custom"] },
      },
    ]);
  });

  it("preserves text, styles, unknown fields, creation, deletion, and order", () => {
    const before = normalizeCanvas(canvasSnapshot());
    const next = canvasSnapshot({
      nodeOverrides: [
        { id: "text", text: "Edited", style: { border: "dashed" }, future: [1, 2] },
        { id: "new", type: "text", text: "New", x: 1, y: 2 },
      ],
      edgeOverrides: [{ id: "new-edge", fromNode: "new", toNode: "file", custom: true }],
    });
    next.nodes = [next.nodes[3]!, next.nodes[0]!, next.nodes[1]!];
    next.edges = [next.edges[1]!];
    const operations = diffCanvas(before, normalizeCanvas(next));
    expect(operations).toContainEqual({ type: "node-delete", id: "group" });
    expect(operations).toContainEqual({ type: "edge-delete", id: "edge" });
    expect(operations).toContainEqual({ type: "node-create", node: next.nodes[0] });
    expect(operations).toContainEqual({ type: "edge-create", edge: next.edges[0] });
    expect(operations).toContainEqual({ type: "node-order", order: ["new", "text", "file"] });
    expect(operations).toContainEqual({ type: "edge-order", order: ["new-edge"] });
    expect(operations).toContainEqual({
      type: "node-patch",
      id: "text",
      patch: { set: { future: [1, 2], style: { border: "dashed" }, text: "Edited" }, remove: [] },
    });
  });

  it("ignores object property order and equivalent snapshots", () => {
    const first = normalizeCanvas({
      nodes: [{ id: "a", type: "text", text: "A", custom: { a: 1, b: 2 } }],
      edges: [],
    });
    const second = normalizeCanvas({
      edges: [],
      nodes: [{ custom: { b: 2, a: 1 }, text: "A", type: "text", id: "a" }],
    });
    expect(diffCanvas(first, second)).toEqual([]);
  });

  it("does not include a stale unchanged text field in a geometry patch", () => {
    const staleShadow = normalizeCanvas({
      nodes: [{ id: "a", type: "text", text: "stale", x: 0, y: 0 }],
      edges: [],
    });
    const localView = normalizeCanvas({
      nodes: [{ id: "a", type: "text", text: "stale", x: 100, y: 0 }],
      edges: [],
    });
    expect(diffCanvas(staleShadow, localView)).toEqual([
      { type: "node-patch", id: "a", patch: { set: { x: 100 }, remove: [] } },
    ]);
  });
});

describe("Canvas operation application", () => {
  it("keeps large-Canvas field updates proportional to the changed items", () => {
    const beforeFile = generatedCanvas(1_000, 1_500);
    const before = normalizeCanvas(beforeFile);
    const moved = structuredClone(beforeFile);
    moved.nodes[750]!.x += 100;
    const operations = diffCanvas(before, normalizeCanvas(moved));
    expect(operations).toEqual([
      {
        type: "node-patch",
        id: "node-750",
        patch: { set: { x: moved.nodes[750]!.x }, remove: [] },
      },
    ]);
    const doc = seededDoc(beforeFile);
    applyCanvasOperations(doc.getMap("root"), operations, doc.clientID);
    expect(fileValue(doc).nodes).toHaveLength(1_000);
    expect(fileValue(doc).edges).toHaveLength(1_500);
  });

  it("merges a local move with concurrent remote text and keeps text as Y.Text", () => {
    const clients = makeCanvasClients();
    const firstRoot = clients.first.getMap("root");
    applyCanvasOperations(
      firstRoot,
      [{ type: "node-patch", id: "text", patch: { set: { x: 500 }, remove: [] } }],
      clients.first.clientID,
    );
    applyCanvasOperations(
      clients.second.getMap("root"),
      [{ type: "node-patch", id: "text", patch: { set: { text: "Remote text" }, remove: [] } }],
      clients.second.clientID,
    );
    clients.syncBoth("second-first");
    const node = fileValue(clients.first).nodes.find((candidate: any) => candidate.id === "text");
    expect(node).toMatchObject({ x: 500, text: "Remote text" });
    expect((firstRoot.get("nodes") as Y.Map<any>).get("text").get("text")).toBeInstanceOf(Y.Text);
  });

  it("applies a batch atomically to deep observers", () => {
    const doc = seededDoc();
    const observer = vi.fn();
    doc.getMap("root").observeDeep(observer);
    applyCanvasOperations(
      doc.getMap("root"),
      [
        { type: "node-patch", id: "text", patch: { set: { x: 10 }, remove: [] } },
        { type: "node-patch", id: "file", patch: { set: { y: 20 }, remove: [] } },
      ],
      doc.clientID,
    );
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("deletes connected edges and blocks stale cross-device recreation", () => {
    const clients = makeCanvasClients();
    applyCanvasOperations(
      clients.first.getMap("root"),
      [{ type: "node-delete", id: "text" }],
      clients.first.clientID,
    );
    clients.syncFirstToSecond();
    applyCanvasOperations(
      clients.second.getMap("root"),
      [{ type: "node-create", node: { id: "text", type: "text", text: "stale" } }],
      clients.second.clientID,
    );
    expect(fileValue(clients.second).nodes.some((node: any) => node.id === "text")).toBe(false);
    expect(fileValue(clients.second).edges).toEqual([]);
  });

  it("allows same-client undo and rejects stable-id changes", () => {
    const doc = seededDoc();
    applyCanvasOperations(doc.getMap("root"), [{ type: "node-delete", id: "text" }], doc.clientID);
    applyCanvasOperations(
      doc.getMap("root"),
      [{ type: "node-create", node: { id: "text", type: "text", text: "Restored" } }],
      doc.clientID,
    );
    applyCanvasOperations(
      doc.getMap("root"),
      [
        {
          type: "node-patch",
          id: "text",
          patch: { set: { id: "changed", color: "1" }, remove: ["id"] },
        },
      ],
      doc.clientID,
    );
    expect(fileValue(doc).nodes.find((node: any) => node.id === "text")).toMatchObject({
      id: "text",
      text: "Restored",
      color: "1",
    });
  });

  it("round-trips deterministic order changes", () => {
    const doc = seededDoc();
    const operations: CanvasOperation[] = [
      { type: "node-order", order: ["group", "file", "text"] },
      { type: "edge-order", order: ["edge"] },
    ];
    applyCanvasOperations(doc.getMap("root"), operations, doc.clientID);
    expect(fileValue(doc).nodes.map((node: any) => node.id)).toEqual(["group", "file", "text"]);
  });

  it("converges concurrent order changes without duplicate Canvas items", () => {
    for (const syncOrder of ["first-second", "second-first"] as const) {
      const clients = makeCanvasClients();
      applyCanvasOperations(
        clients.first.getMap("root"),
        [{ type: "node-order", order: ["group", "text", "file"] }],
        clients.first.clientID,
      );
      applyCanvasOperations(
        clients.second.getMap("root"),
        [{ type: "node-order", order: ["file", "group", "text"] }],
        clients.second.clientID,
      );
      clients.syncBoth(syncOrder);
      const firstOrder = fileValue(clients.first).nodes.map((node: any) => node.id);
      const secondOrder = fileValue(clients.second).nodes.map((node: any) => node.id);
      expect(secondOrder).toEqual(firstOrder);
      expect(new Set(firstOrder).size).toBe(3);
      expect(firstOrder).toHaveLength(3);
    }
  });

  it("canonicalizes duplicate raw order entries created by concurrent reorders", () => {
    const clients = makeCanvasClients();
    applyCanvasOperations(
      clients.first.getMap("root"),
      [{ type: "node-order", order: ["group", "text", "file"] }],
      clients.first.clientID,
    );
    applyCanvasOperations(
      clients.second.getMap("root"),
      [{ type: "node-order", order: ["file", "group", "text"] }],
      clients.second.clientID,
    );
    clients.syncBoth();

    const firstOrder = clients.first.getMap("root").get("nodeOrder") as Y.Array<string>;
    expect(firstOrder.toArray()).toHaveLength(6);
    clients.first.transact(() => canonicalizeCanvasOrders(clients.first.getMap("root")));
    clients.syncFirstToSecond();

    const expected = firstOrder.toArray();
    expect(expected).toHaveLength(3);
    expect(new Set(expected).size).toBe(3);
    expect((clients.second.getMap("root").get("nodeOrder") as Y.Array<string>).toArray()).toEqual(
      expected,
    );
  });
});
