import type { StructuredCanvas } from "../structured/canvas";
import type { CanvasOperation } from "../structured/canvasOperations";
import { discoverCanvasTextEditor, type ActiveCanvasTextEditor } from "./CanvasTextEditorAdapter";

export interface CanvasViewState {
  selection: unknown[];
  interaction: unknown;
  viewport: { x: number; y: number; scale: number } | null;
}

export interface CanvasBatchResult {
  applied: boolean;
  reason?: "unsupported" | "exception";
  error?: unknown;
}

type PrivateObject = Record<string, unknown>;
type PrivateCanvas = {
  getData: () => unknown;
  selection?: unknown;
  nodes?: unknown;
  edges?: unknown;
  interactionState?: unknown;
  interaction?: unknown;
  requestFrame?: unknown;
  requestRender?: unknown;
  addNode?: unknown;
  addEdge?: unknown;
  removeNode?: unknown;
  removeEdge?: unknown;
  tx?: unknown;
  ty?: unknown;
  tZoom?: unknown;
  zoom?: unknown;
  viewport?: unknown;
  setViewport?: unknown;
  realtimeIncrementalSafe?: boolean;
};

/** Feature-detected facade around Obsidian's private live Canvas API. */
export class CanvasViewAdapter {
  constructor(
    private readonly canvas: PrivateCanvas,
    private readonly structuralMutations = true,
  ) {}

  read(): unknown {
    return this.canvas.getData();
  }

  activeTextEditor(): ActiveCanvasTextEditor | null {
    return discoverCanvasTextEditor(this.canvas);
  }

  readState(): CanvasViewState {
    return {
      selection: readSelection(this.canvas.selection),
      interaction: this.canvas.interactionState ?? this.canvas.interaction ?? null,
      viewport: readViewport(this.canvas),
    };
  }

  writeState(state: CanvasViewState): void {
    writeSelection(this.canvas.selection, state.selection);
    if (state.viewport) writeViewport(this.canvas, state.viewport);
    // Interaction objects are owned by Obsidian and must never be replaced.
  }

  requestRender(): void {
    const render = this.canvas.requestFrame ?? this.canvas.requestRender;
    if (typeof render === "function") render.call(this.canvas);
  }

  apply(operations: readonly CanvasOperation[], current: StructuredCanvas): CanvasBatchResult {
    if (!operations.length) return { applied: true };
    if (!this.supports(operations)) return { applied: false, reason: "unsupported" };
    const state = this.readState();
    try {
      for (const operation of operations) this.applyOne(operation, current);
      this.writeState(state);
      this.requestRender();
      return { applied: true };
    } catch (error) {
      // A caller must perform a full import: an exception may have happened after
      // earlier operations in this batch mutated the view.
      try {
        this.writeState(state);
      } catch {
        /* full import remains authoritative */
      }
      return { applied: false, reason: "exception", error };
    }
  }

  private supports(operations: readonly CanvasOperation[]): boolean {
    if (this.canvas.realtimeIncrementalSafe === false) return false;
    for (const operation of operations) {
      switch (operation.type) {
        case "node-order":
        case "edge-order":
        case "node-restore":
        case "edge-restore":
          return false;
        case "node-create":
          if (!this.structuralMutations) return false;
          if (typeof this.canvas.addNode !== "function") return false;
          break;
        case "edge-create":
          if (!this.structuralMutations) return false;
          if (typeof this.canvas.addEdge !== "function") return false;
          break;
        case "node-delete":
          if (!this.structuralMutations) return false;
          if (typeof this.canvas.removeNode !== "function" || !this.find("nodes", operation.id))
            return false;
          break;
        case "edge-delete":
          if (!this.structuralMutations) return false;
          if (typeof this.canvas.removeEdge !== "function" || !this.find("edges", operation.id))
            return false;
          break;
        case "node-patch":
          if (typeof this.find("nodes", operation.id)?.setData !== "function") return false;
          break;
        case "edge-patch":
          if (typeof this.find("edges", operation.id)?.setData !== "function") return false;
          break;
      }
    }
    return true;
  }

  private applyOne(operation: CanvasOperation, current: StructuredCanvas): void {
    switch (operation.type) {
      case "node-create":
        (this.canvas.addNode as (data: unknown) => void).call(this.canvas, operation.node);
        return;
      case "edge-create":
        (this.canvas.addEdge as (data: unknown) => void).call(this.canvas, operation.edge);
        return;
      case "node-delete":
        (this.canvas.removeNode as (item: unknown) => void).call(
          this.canvas,
          this.find("nodes", operation.id),
        );
        return;
      case "edge-delete":
        (this.canvas.removeEdge as (item: unknown) => void).call(
          this.canvas,
          this.find("edges", operation.id),
        );
        return;
      case "node-patch":
        this.patch(this.find("nodes", operation.id)!, current.nodes[operation.id], operation.patch);
        return;
      case "edge-patch":
        this.patch(this.find("edges", operation.id)!, current.edges[operation.id], operation.patch);
        return;
      default:
        throw new Error(`Unsupported canvas operation: ${operation.type}`);
    }
  }

  private patch(
    item: PrivateObject,
    value: unknown,
    patch: { set: Record<string, unknown>; remove: string[] },
  ): void {
    const base: PrivateObject =
      value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
    for (const key of patch.remove) delete base[key];
    Object.assign(base, patch.set);
    (item.setData as (data: unknown) => void).call(item, base);
  }

  private find(collection: "nodes" | "edges", id: string): PrivateObject | undefined {
    const values = this.canvas[collection];
    let result: unknown;
    if (values instanceof Map) result = values.get(id);
    else if (
      values &&
      typeof values === "object" &&
      "get" in values &&
      typeof values.get === "function"
    )
      result = values.get(id);
    else if (values && typeof values === "object") result = (values as PrivateObject)[id];
    if (result && typeof result === "object") return result as PrivateObject;
    return undefined;
  }
}

function readSelection(selection: unknown): unknown[] {
  if (selection instanceof Map) return [...selection.keys()];
  if (selection instanceof Set) return [...selection];
  return [];
}

function writeSelection(selection: unknown, values: unknown[]): void {
  if (!(selection instanceof Set) && !(selection instanceof Map)) return;
  const prior = selection instanceof Map ? new Map(selection) : null;
  selection.clear();
  for (const value of values) {
    if (selection instanceof Map) selection.set(value, prior?.get(value) ?? value);
    else selection.add(value);
  }
}

function readViewport(canvas: PrivateCanvas): CanvasViewState["viewport"] {
  const viewport =
    canvas.viewport && typeof canvas.viewport === "object"
      ? (canvas.viewport as PrivateObject)
      : {};
  const x = canvas.tx ?? viewport.x;
  const y = canvas.ty ?? viewport.y;
  const scale = canvas.tZoom ?? canvas.zoom ?? viewport.scale;
  return typeof x === "number" && typeof y === "number" && typeof scale === "number"
    ? { x, y, scale }
    : null;
}

function writeViewport(
  canvas: PrivateCanvas,
  viewport: NonNullable<CanvasViewState["viewport"]>,
): void {
  if (typeof canvas.setViewport === "function")
    canvas.setViewport(viewport.x, viewport.y, viewport.scale);
  else if ("tx" in canvas && "ty" in canvas && ("tZoom" in canvas || "zoom" in canvas)) {
    canvas.tx = viewport.x;
    canvas.ty = viewport.y;
    if ("tZoom" in canvas) canvas.tZoom = viewport.scale;
    else canvas.zoom = viewport.scale;
  }
}
