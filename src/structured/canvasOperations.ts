import * as Y from "yjs";
import { parseCanvas, type StructuredCanvas } from "./canvas";
import { reconcileArray, reconcileValue, type JsonValue, type ReconcileOptions } from "./reconcile";

export interface CanvasFieldPatch {
  set: Record<string, JsonValue>;
  remove: string[];
}

export type CanvasOperation =
  | { type: "node-create"; node: Record<string, JsonValue> }
  | { type: "node-patch"; id: string; patch: CanvasFieldPatch }
  | { type: "node-delete"; id: string }
  | { type: "node-restore"; node: Record<string, JsonValue> }
  | { type: "edge-create"; edge: Record<string, JsonValue> }
  | { type: "edge-patch"; id: string; patch: CanvasFieldPatch }
  | { type: "edge-delete"; id: string }
  | { type: "edge-restore"; edge: Record<string, JsonValue> }
  | { type: "node-order"; order: string[] }
  | { type: "edge-order"; order: string[] };

export function normalizeCanvas(data: unknown): StructuredCanvas {
  return parseCanvas(JSON.stringify(data ?? {}));
}

export function diffCanvas(previous: StructuredCanvas, next: StructuredCanvas): CanvasOperation[] {
  return [
    ...diffItems("node", previous.nodes, next.nodes),
    ...diffItems("edge", previous.edges, next.edges),
    ...(equalJson(previous.nodeOrder, next.nodeOrder)
      ? []
      : [{ type: "node-order" as const, order: [...next.nodeOrder] }]),
    ...(equalJson(previous.edgeOrder, next.edgeOrder)
      ? []
      : [{ type: "edge-order" as const, order: [...next.edgeOrder] }]),
  ];
}

function diffItems(
  kind: "node" | "edge",
  previous: Record<string, JsonValue>,
  next: Record<string, JsonValue>,
): CanvasOperation[] {
  const operations: CanvasOperation[] = [];
  const previousIds = Object.keys(previous).sort();
  const nextIds = Object.keys(next).sort();

  for (const id of previousIds) {
    if (!(id in next)) operations.push({ type: `${kind}-delete`, id } as CanvasOperation);
  }
  for (const id of nextIds) {
    const nextItem = asRecord(next[id]);
    if (!nextItem) continue;
    const previousItem = asRecord(previous[id]);
    if (!previousItem) {
      operations.push({
        type: `${kind}-create`,
        [kind]: cloneJson(nextItem),
      } as CanvasOperation);
      continue;
    }
    const patch = diffFields(previousItem, nextItem);
    if (Object.keys(patch.set).length || patch.remove.length) {
      operations.push({ type: `${kind}-patch`, id, patch } as CanvasOperation);
    }
  }
  return operations;
}

function diffFields(
  previous: Record<string, JsonValue>,
  next: Record<string, JsonValue>,
): CanvasFieldPatch {
  const set: Record<string, JsonValue> = {};
  const remove: string[] = [];
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of [...keys].sort()) {
    if (key === "id") continue;
    if (!(key in next)) remove.push(key);
    else if (!(key in previous) || !equalJson(previous[key], next[key])) {
      set[key] = cloneJson(next[key]!);
    }
  }
  return { set, remove };
}

export function applyCanvasOperations(
  root: Y.Map<any>,
  operations: readonly CanvasOperation[],
  clientID: number,
): void {
  const doc = root.doc;
  const apply = () => {
    const nodes = ensureMap(root, "nodes");
    const edges = ensureMap(root, "edges");
    const deletedNodes = ensureMap(root, "deletedNodeIds");
    const deletedEdges = ensureMap(root, "deletedEdgeIds");
    const nodeOrder = ensureArray(root, "nodeOrder");
    const edgeOrder = ensureArray(root, "edgeOrder");

    for (const operation of operations) {
      switch (operation.type) {
        case "node-create":
          createItem(nodes, deletedNodes, operation.node, clientID);
          break;
        case "node-patch":
          patchItem(nodes, operation.id, operation.patch);
          break;
        case "node-delete":
          deleteItem(nodes, deletedNodes, nodeOrder, operation.id, clientID);
          deleteConnectedEdges(edges, deletedEdges, edgeOrder, operation.id, clientID);
          break;
        case "node-restore":
          restoreItem(nodes, deletedNodes, operation.node);
          break;
        case "edge-create":
          createItem(edges, deletedEdges, operation.edge, clientID);
          break;
        case "edge-patch":
          patchItem(edges, operation.id, operation.patch);
          break;
        case "edge-delete":
          deleteItem(edges, deletedEdges, edgeOrder, operation.id, clientID);
          break;
        case "edge-restore":
          restoreItem(edges, deletedEdges, operation.edge);
          break;
        case "node-order":
          reconcileArray(nodeOrder, validOrder(operation.order, nodes), {});
          break;
        case "edge-order":
          reconcileArray(edgeOrder, validOrder(operation.order, edges), {});
          break;
      }
    }
  };
  if (doc) doc.transact(apply);
  else apply();
}

function restoreItem(
  items: Y.Map<any>,
  tombstones: Y.Map<number>,
  value: Record<string, JsonValue>,
): void {
  const id = typeof value.id === "string" ? value.id : null;
  if (!id) return;
  tombstones.delete(id);
  let item = items.get(id);
  if (!(item instanceof Y.Map)) {
    item = new Y.Map();
    items.set(id, item);
  }
  patchItem(items, id, { set: value, remove: [] });
}

function createItem(
  items: Y.Map<any>,
  tombstones: Y.Map<number>,
  value: Record<string, JsonValue>,
  clientID: number,
): void {
  const id = typeof value.id === "string" ? value.id : null;
  if (!id) return;
  const tombstonedBy = tombstones.get(id);
  if (tombstonedBy !== undefined) {
    if (tombstonedBy !== clientID) return;
    tombstones.delete(id);
  }
  let item = items.get(id);
  if (!(item instanceof Y.Map)) {
    item = new Y.Map();
    items.set(id, item);
  }
  patchItem(items, id, { set: value, remove: [] });
}

function patchItem(items: Y.Map<any>, id: string, patch: CanvasFieldPatch): void {
  const item = items.get(id);
  if (!(item instanceof Y.Map)) return;
  for (const key of [...patch.remove].sort()) {
    if (key !== "id") item.delete(key);
  }
  const options: ReconcileOptions = {};
  for (const key of Object.keys(patch.set).sort()) {
    if (key === "id") continue;
    const next = patch.set[key]!;
    const current = item.get(key);
    const reconciled = reconcileValue(current, next, key, options, (created) =>
      item.set(key, created),
    );
    if (item.get(key) !== reconciled) item.set(key, reconciled);
  }
  if (item.get("id") !== id) item.set("id", id);
}

function deleteItem(
  items: Y.Map<any>,
  tombstones: Y.Map<number>,
  order: Y.Array<any>,
  id: string,
  clientID: number,
): void {
  if (!items.has(id)) return;
  tombstones.set(id, clientID);
  items.delete(id);
  reconcileArray(
    order,
    order.toArray().filter((candidate): candidate is string => candidate !== id),
    {},
  );
}

function deleteConnectedEdges(
  edges: Y.Map<any>,
  tombstones: Y.Map<number>,
  order: Y.Array<any>,
  nodeId: string,
  clientID: number,
): void {
  for (const [edgeId, edge] of edges.entries()) {
    if (
      edge instanceof Y.Map &&
      (edge.get("fromNode") === nodeId || edge.get("toNode") === nodeId)
    ) {
      deleteItem(edges, tombstones, order, edgeId, clientID);
    }
  }
}

function validOrder(order: readonly string[], items: Y.Map<any>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of order) {
    if (items.has(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  for (const id of items.keys()) {
    if (!seen.has(id)) result.push(id);
  }
  return result;
}

function ensureMap(root: Y.Map<any>, key: string): Y.Map<any> {
  const existing = root.get(key);
  if (existing instanceof Y.Map) return existing;
  const map = new Y.Map();
  root.set(key, map);
  return map;
}

function ensureArray(root: Y.Map<any>, key: string): Y.Array<any> {
  const existing = root.get(key);
  if (existing instanceof Y.Array) return existing;
  const array = new Y.Array();
  root.set(key, array);
  return array;
}

function equalJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => equalJson(value, right[index]))
    );
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && equalJson(leftRecord[key], rightRecord[key]),
    )
  );
}

function asRecord(value: unknown): Record<string, JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
