import { vi } from "vitest";
import * as Y from "yjs";
import {
  parseCanvas,
  reconcileCanvas,
  serializeCanvas,
  type StructuredCanvas,
} from "../../src/structured/canvas";
import { toValue, type JsonValue } from "../../src/structured/reconcile";

export interface CanvasSnapshotOptions {
  nodeOverrides?: Array<Record<string, JsonValue>>;
  edgeOverrides?: Array<Record<string, JsonValue>>;
}

export function canvasSnapshot(options: CanvasSnapshotOptions = {}) {
  const nodes: Array<Record<string, JsonValue>> = [
    {
      id: "text",
      type: "text",
      text: "Hello",
      x: 0,
      y: 0,
      width: 240,
      height: 120,
      custom: { future: true },
    },
    {
      id: "file",
      type: "file",
      file: "assets/image.png",
      x: 300,
      y: 0,
      width: 320,
      height: 200,
      unknownNodeField: "preserved",
    },
    {
      id: "group",
      type: "group",
      label: "Group",
      x: -40,
      y: -40,
      width: 720,
      height: 320,
      color: "3",
    },
  ];
  const edges: Array<Record<string, JsonValue>> = [
    {
      id: "edge",
      fromNode: "text",
      toNode: "file",
      fromSide: "right",
      toSide: "left",
      unknownEdgeField: { value: 1 },
    },
  ];
  for (const override of options.nodeOverrides ?? []) {
    const index = nodes.findIndex((node) => node.id === override.id);
    if (index >= 0) nodes[index] = { ...nodes[index], ...override };
    else nodes.push(override);
  }
  for (const override of options.edgeOverrides ?? []) {
    const index = edges.findIndex((edge) => edge.id === override.id);
    if (index >= 0) edges[index] = { ...edges[index], ...override };
    else edges.push(override);
  }
  return { nodes, edges, customTopLevel: "ignored-by-json-canvas" };
}

export function normalizedCanvas(data: unknown): StructuredCanvas {
  return parseCanvas(JSON.stringify(data));
}

export function generatedCanvas(nodeCount = 500, edgeCount = 750) {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `node-${index}`,
    type: index % 5 === 0 ? "file" : "text",
    ...(index % 5 === 0 ? { file: `assets/${index}.png` } : { text: `Card ${index}` }),
    x: (index % 25) * 260,
    y: Math.floor(index / 25) * 180,
    width: 220,
    height: 140,
    custom: { index, tags: ["generated", String(index % 7)] },
  }));
  const edges = Array.from({ length: edgeCount }, (_, index) => ({
    id: `edge-${index}`,
    fromNode: `node-${index % nodeCount}`,
    toNode: `node-${(index + 1) % nodeCount}`,
    label: `Edge ${index}`,
  }));
  return { nodes, edges };
}

export function makeCanvasClients(seed = canvasSnapshot()) {
  const first = new Y.Doc();
  const second = new Y.Doc();
  applySnapshot(first, seed);
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
  return {
    first,
    second,
    applyFirst: (data: unknown) => applySnapshot(first, data),
    applySecond: (data: unknown) => applySnapshot(second, data),
    syncFirstToSecond: () => Y.applyUpdate(second, Y.encodeStateAsUpdate(first)),
    syncSecondToFirst: () => Y.applyUpdate(first, Y.encodeStateAsUpdate(second)),
    syncBoth: (order: "first-second" | "second-first" = "first-second") => {
      if (order === "first-second") {
        Y.applyUpdate(first, Y.encodeStateAsUpdate(second));
        Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
      } else {
        Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
        Y.applyUpdate(first, Y.encodeStateAsUpdate(second));
      }
    },
    value: (doc: Y.Doc) => JSON.parse(serializeCanvas(toValue(doc.getMap("root")))),
  };
}

function applySnapshot(doc: Y.Doc, data: unknown) {
  doc.transact(() => reconcileCanvas(doc.getMap("root"), normalizedCanvas(data), doc.clientID));
}

export function makeLiveCanvasFixture(
  path = "Board.canvas",
  initialData: unknown = canvasSnapshot(),
) {
  let data = structuredClone(initialData);
  let mounted = true;
  const host = document.createElement("div");
  const canvas = {
    getData: vi.fn(() => structuredClone(data)),
    importData: vi.fn((next: unknown) => {
      data = structuredClone(next);
    }),
    requestSave: vi.fn(),
    requestFrame: vi.fn(),
  };
  const view: any = {
    getViewType: () => "canvas",
    file: { path },
    canvas,
    containerEl: host,
  };
  const workspace = {
    iterateAllLeaves: (callback: (leaf: unknown) => void) => {
      if (mounted) callback({ view });
    },
    getLeavesOfType: () => (mounted ? [{ view }] : []),
  };
  return {
    canvas,
    view,
    host,
    workspace,
    data: () => structuredClone(data),
    setData: (next: unknown) => {
      data = structuredClone(next);
    },
    reuseFor: (nextPath: string, nextData: unknown) => {
      view.file = { path: nextPath };
      data = structuredClone(nextData);
    },
    close: () => {
      mounted = false;
    },
    remount: () => {
      mounted = true;
    },
  };
}
