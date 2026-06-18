import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { reconcileInto, toValue } from "../../src/structured/reconcile";
import { parseCanvas, serializeCanvas } from "../../src/structured/canvas";
import { parseBase, serializeBase } from "../../src/structured/base";

describe("structured reconciler", () => {
  it("preserves unknown keys and is idempotent", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    reconcileInto(root, {
      known: true,
      future: { nested: "value" },
      items: [{ id: "a", label: "Alpha" }],
    });
    const before = Y.encodeStateAsUpdate(doc).length;
    reconcileInto(root, toValue(root));
    const after = Y.encodeStateAsUpdate(doc).length;

    expect(toValue(root)).toEqual({
      known: true,
      future: { nested: "value" },
      items: [{ id: "a", label: "Alpha" }],
    });
    expect(after).toBe(before);
  });

  it("stores configured text fields as Y.Text", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    reconcileInto(root, { text: "hello" });
    expect(root.get("text")).toBeInstanceOf(Y.Text);
    reconcileInto(root, { text: "hello world" });
    expect(toValue(root)).toEqual({ text: "hello world" });
  });
});

describe("canvas serializer", () => {
  it("round-trips JSON Canvas arrays through id-keyed maps", () => {
    const parsed = parseCanvas(
      JSON.stringify({
        nodes: [{ id: "n1", type: "text", text: "hi", custom: 1 }],
        edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }],
      }),
    );

    expect(parsed.nodeOrder).toEqual(["n1"]);
    expect(parsed.edgeOrder).toEqual(["e1"]);
    expect(JSON.parse(serializeCanvas(parsed))).toEqual({
      nodes: [{ id: "n1", type: "text", text: "hi", custom: 1 }],
      edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }],
    });
  });
});

describe("canvas concurrent merge", () => {
  it("merges a node move and a different node's text edit cleanly", () => {
    const seed = {
      nodes: [
        { id: "n1", type: "text", text: "first", x: 0, y: 0 },
        { id: "n2", type: "text", text: "second", x: 100, y: 0 },
      ],
      edges: [],
    };

    const apply = (doc: Y.Doc, data: unknown) => {
      doc.transact(() =>
        reconcileInto(doc.getMap("root"), parseCanvas(JSON.stringify(data)) as any),
      );
    };

    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    apply(doc1, seed);
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    // Client 1 moves n1; client 2 edits n2's text — concurrently, offline.
    apply(doc1, {
      nodes: [
        { id: "n1", type: "text", text: "first", x: 250, y: 80 },
        { id: "n2", type: "text", text: "second", x: 100, y: 0 },
      ],
      edges: [],
    });
    apply(doc2, {
      nodes: [
        { id: "n1", type: "text", text: "first", x: 0, y: 0 },
        { id: "n2", type: "text", text: "second EDITED", x: 100, y: 0 },
      ],
      edges: [],
    });

    // Exchange updates both directions.
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    const result1 = serializeCanvas(toValue(doc1.getMap("root")));
    const result2 = serializeCanvas(toValue(doc2.getMap("root")));
    expect(result1).toBe(result2);

    const nodes = JSON.parse(result1).nodes as Array<Record<string, unknown>>;
    const n1 = nodes.find((n) => n.id === "n1")!;
    const n2 = nodes.find((n) => n.id === "n2")!;
    expect(n1.x).toBe(250);
    expect(n1.y).toBe(80);
    expect(n2.text).toBe("second EDITED");
  });
});

describe("base serializer", () => {
  it("round-trips YAML values", () => {
    const value = parseBase("views:\n  - type: table\n    filter: status == 'open'\n");
    expect(parseBase(serializeBase(value))).toEqual(value);
  });
});
