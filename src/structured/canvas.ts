import type { JsonValue } from "./reconcile";

export interface StructuredCanvas extends Record<string, JsonValue> {
  nodes: Record<string, JsonValue>;
  edges: Record<string, JsonValue>;
  nodeOrder: string[];
  edgeOrder: string[];
}

export function parseCanvas(text: string): StructuredCanvas {
  const data = text.trim() ? JSON.parse(text) : {};
  const nodes: Record<string, JsonValue> = {};
  const edges: Record<string, JsonValue> = {};
  const nodeOrder: string[] = [];
  const edgeOrder: string[] = [];
  for (const node of Array.isArray(data.nodes) ? data.nodes : []) {
    if (!node || typeof node.id !== "string") continue;
    nodes[node.id] = node;
    nodeOrder.push(node.id);
  }
  for (const edge of Array.isArray(data.edges) ? data.edges : []) {
    if (!edge || typeof edge.id !== "string") continue;
    edges[edge.id] = edge;
    edgeOrder.push(edge.id);
  }
  return { nodes, edges, nodeOrder, edgeOrder };
}

export function serializeCanvas(value: JsonValue): string {
  const root = isObject(value) ? value : {};
  const nodes = isObject(root.nodes) ? root.nodes : {};
  const edges = isObject(root.edges) ? root.edges : {};
  const nodeOrder = Array.isArray(root.nodeOrder)
    ? root.nodeOrder.filter(isString)
    : Object.keys(nodes);
  const edgeOrder = Array.isArray(root.edgeOrder)
    ? root.edgeOrder.filter(isString)
    : Object.keys(edges);
  const orderedNodes = [...nodeOrder, ...Object.keys(nodes).filter((id) => !nodeOrder.includes(id))]
    .map((id) => nodes[id])
    .filter(isObject);
  const orderedEdges = [...edgeOrder, ...Object.keys(edges).filter((id) => !edgeOrder.includes(id))]
    .map((id) => edges[id])
    .filter(isObject);
  return `${JSON.stringify({ nodes: orderedNodes, edges: orderedEdges }, null, 2)}\n`;
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
