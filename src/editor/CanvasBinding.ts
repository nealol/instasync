import type RealtimePlugin from "../main";
import type { CanvasDocument } from "../CanvasDocument";
import { parseCanvas, type StructuredCanvas } from "../structured/canvas";
import { diffCanvas, normalizeCanvas, type CanvasOperation } from "../structured/canvasOperations";
import {
  mountCanvasCursorOverlay,
  mountPresenceStack,
  readCanvasViewport,
  setCanvasPresence,
} from "../presence";
import { CanvasTextCardBinding } from "./CanvasTextCardBinding";
import { CanvasViewAdapter } from "./CanvasViewAdapter";
import { dbg } from "../debug";
import type { EventRef } from "obsidian";

/**
 * Origin tag stamped on the Yjs transaction when we fold a local canvas edit
 * (captured via the patched `requestSave`) into the CRDT. The document's root
 * observer uses it to avoid re-importing our own edit back into the live canvas,
 * which would disrupt the in-progress selection/drag.
 */
export const CANVAS_LOCAL_ORIGIN = Symbol("realtime-canvas-request-save");
let loggedUnsupported = false;

interface InternalCanvas {
  getData: () => unknown;
  importData: (data: unknown, clear?: boolean) => void;
  requestSave: (...args: unknown[]) => unknown;
  requestFrame?: () => void;
  selection?: Set<unknown> | Map<unknown, unknown>;
  nodes?: unknown;
  edges?: unknown;
  addNode?: (data: unknown) => unknown;
  removeNode?: (node: unknown) => unknown;
  addEdge?: (data: unknown) => unknown;
  removeEdge?: (edge: unknown) => unknown;
}

interface BoundCanvasView {
  canvas: InternalCanvas;
  host: HTMLElement;
  view: {
    file?: { path?: string } | null;
    getViewData?: () => unknown;
    setViewData?: (data: string, clear?: boolean) => void;
  };
}

export class CanvasBinding {
  private plugin: RealtimePlugin;
  private doc: CanvasDocument;
  private canvas: InternalCanvas | null = null;
  private adapter: CanvasViewAdapter | null = null;
  /** The Obsidian view the canvas belongs to, kept to re-verify `file.path`. */
  private view: BoundCanvasView["view"] | null = null;
  private presenceCleanup: (() => void) | null = null;
  private originalRequestSave: InternalCanvas["requestSave"] | null = null;
  /** Our patch function, so unpatch can tell whether we're still the top patch. */
  private patchedRequestSave: InternalCanvas["requestSave"] | null = null;
  private applyingRemote = false;
  /**
   * Normalized snapshot of the last data pushed into the view via
   * {@link applyRemote}. Obsidian's `requestSave` is debounced and may fire
   * *after* {@link applyingRemote} has been reset, so the flag alone can't
   * suppress that bounce-back. Comparing the captured data against this hash
   * ignores it precisely without muting a genuine concurrent local edit.
   */
  private lastImportedHash: string | null = null;
  /** Last normalized state accepted by this exact live view. */
  private shadow: ReturnType<typeof normalizeCanvas> | null = null;
  private interactionActive = false;
  private interactionTimer: ReturnType<typeof setInterval> | null = null;
  private remoteTimer: ReturnType<typeof setTimeout> | null = null;
  private remotePending = false;
  private lifecycleCleanup: (() => void) | null = null;
  private presenceSequence = 0;
  private presenceRaf: number | null = null;
  private textCardBinding: CanvasTextCardBinding | null = null;
  private editingNodeId: string | null = null;
  private attachmentIndicator: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private attachmentPaths = new Set<string>();
  private attachmentEventRefs: EventRef[] = [];

  constructor(plugin: RealtimePlugin, doc: CanvasDocument) {
    this.plugin = plugin;
    this.doc = doc;
  }

  /** True only while we're patched onto a live, recognized canvas view. */
  isActive(): boolean {
    return this.canvas !== null;
  }

  tryBind(): void {
    const found = this.findOpenCanvas();
    // Same live canvas we are already patched onto — nothing to do.
    if (found && found.canvas === this.canvas) return;
    // The leaf was closed (canvas == null) or reopened as a fresh Canvas
    // instance: drop the stale patch before binding the new one, so live
    // editing survives close/reopen instead of silently dying.
    if (this.canvas && (!found || found.canvas !== this.canvas)) this.unpatch();
    if (!found) return;
    const { canvas, host, view } = found;
    this.canvas = canvas;
    this.adapter = new CanvasViewAdapter(canvas, typeof view.setViewData !== "function");
    this.view = view;
    this.host = host;
    const vault = this.plugin.app.vault;
    if (vault && typeof vault.on === "function") {
      const refreshAttachments = () => this.renderAttachmentIndicator();
      this.attachmentEventRefs = [
        vault.on("create", refreshAttachments),
        vault.on("delete", refreshAttachments),
        vault.on("rename", refreshAttachments),
      ];
    }
    // Capture the original in the closure (not via the mutable field): a stale
    // copy of this patch can linger on a canvas instance that Obsidian reuses
    // for another file, and it must keep delegating to the save function it
    // wrapped even after this binding rebinds elsewhere.
    const original = canvas.requestSave.bind(canvas);
    this.originalRequestSave = original;
    this.patchedRequestSave = (...args: unknown[]) => {
      const result = original(...args);
      if (!this.applyingRemote) this.captureLocal();
      return result;
    };
    canvas.requestSave = this.patchedRequestSave;
    this.applyRemote();
    // Mount presence avatar stack + canvas cursor overlay. Both clean up via
    // presenceCleanup, which is called in unpatch().
    const stackCleanup = mountPresenceStack(
      host,
      this.doc.awareness,
      "canvas",
      "realtime-canvas-presence-stack",
    );
    const cursorCleanup = mountCanvasCursorOverlay(host, this.doc.awareness, () => this.canvas);
    this.presenceCleanup = () => {
      cursorCleanup();
      stackCleanup();
    };
    this.bindInteractionLifecycle(host);
    this.publishPresence(false);
    this.textCardBinding = new CanvasTextCardBinding(
      this.doc,
      () => this.canvas,
      (nodeId) => {
        this.editingNodeId = nodeId;
        this.publishPresence(this.interactionActive);
      },
    );
    this.textCardBinding.start();
  }

  /**
   * True when the bound view no longer displays this document's file.
   * Obsidian reuses the same view — and the same Canvas instance — when a
   * leaf switches to a different canvas file, so the binding must re-verify
   * the path at every capture/import. Acting through a reused view would
   * read the *other* file's content into this CRDT, or write this CRDT's
   * content into the other file on disk.
   */
  private isStaleView(): boolean {
    return this.view?.file?.path !== this.doc.path;
  }

  /** Unpatch if the bound canvas is gone or its view now shows another file. */
  unbindIfStale(): void {
    if (!this.canvas) return;
    const found = this.findOpenCanvas();
    if (!found || found.canvas !== this.canvas || this.isStaleView()) this.unpatch();
  }

  /** Push the CRDT's current value into the live view and converge disk. */
  applyRemote(): void {
    if (!this.canvas) return;
    // The leaf may have switched this reused view to a different file since we
    // bound; importing here would overwrite that file with this doc's content.
    if (this.isStaleView()) {
      this.unpatch();
      return;
    }
    // Do not import the constructor-time empty Y.Doc into an already-open
    // canvas. The real value arrives after IndexedDB/server startup reconcile.
    if (!this.doc.isReady()) return;
    const next = this.doc.canvasData();
    this.prioritizeAttachments(normalizeCanvas(next));
    const nextHash = hashCanvasData(next);
    // Skip a pointless re-render (and the scroll/selection churn it brings)
    // when the live view already shows this content. Still stamp the hash so
    // a delayed requestSave triggered by the *previous* import is ignored.
    if (hashCanvasData(this.canvas.getData()) === nextHash) {
      this.lastImportedHash = nextHash;
      this.shadow = normalizeCanvas(this.canvas.getData());
      return;
    }
    this.applyingRemote = true;
    this.lastImportedHash = nextHash;
    try {
      if (this.shadow && this.adapter) {
        const operations = incrementalOperations(this.shadow, normalizeCanvas(next));
        if (operations) {
          const result = this.adapter.apply(operations, this.shadow);
          if (result.applied) {
            dbg("canvas incremental apply", this.doc.path, operations.length);
            this.shadow = normalizeCanvas(next);
            this.originalRequestSave?.();
            return;
          }
          dbg("canvas incremental fallback", this.doc.path, result.reason);
          logAdapterFallback(result.reason ?? "unsupported", result.error);
        } else logAdapterFallback("ordering");
      }
      // Pass clear=true so importData REMOVES nodes/edges absent from the
      // CRDT snapshot, not just adds/updates. Without it, deleted edges never
      // leave the live view — the original "deleted edges not propagating" bug.
      this.importSnapshot(next);
      this.shadow = normalizeCanvas(next);
      this.canvas.requestFrame?.();
      // Converge disk too: while the view is open the StructuredDocument
      // write-through is suppressed in favor of this binding, so a remote
      // change that we just pushed into the view must also be persisted —
      // otherwise the on-disk file stays stale and a later close/reopen or
      // onDiskChanged fold can resurrect deleted edges.
      this.originalRequestSave?.();
    } catch (e) {
      console.error(`[Realtime] failed to apply canvas update for ${this.doc.path}`, e);
    } finally {
      this.applyingRemote = false;
    }
  }

  private importSnapshot(data: unknown): void {
    if (typeof this.view?.setViewData === "function") {
      this.view.setViewData(JSON.stringify(data), true);
    } else {
      this.canvas?.importData(data, true);
    }
  }

  /** Coalesce observer bursts and defer disruptive imports during local gestures. */
  scheduleRemote(): void {
    if (!this.canvas) return;
    this.remotePending = true;
    if (this.interactionActive || this.remoteTimer) {
      dbg("canvas remote apply deferred", this.doc.path);
      return;
    }
    this.remoteTimer = setTimeout(() => {
      this.remoteTimer = null;
      if (!this.remotePending || this.interactionActive) return;
      this.remotePending = false;
      this.applyRemote();
    }, 16);
  }

  destroy(): void {
    this.unpatch();
  }

  /** Restore the canvas's original `requestSave` and forget the binding. */
  private unpatch(): void {
    this.stopInteraction(false);
    if (this.remoteTimer) clearTimeout(this.remoteTimer);
    this.remoteTimer = null;
    this.remotePending = false;
    this.lifecycleCleanup?.();
    this.lifecycleCleanup = null;
    this.textCardBinding?.destroy();
    this.textCardBinding = null;
    this.editingNodeId = null;
    this.attachmentIndicator?.remove();
    this.attachmentIndicator = null;
    this.host = null;
    this.plugin.vaultSync?.unprioritizeCanvasAttachments(this.attachmentPaths);
    this.attachmentPaths.clear();
    for (const eventRef of this.attachmentEventRefs) this.plugin.app.vault?.offref(eventRef);
    this.attachmentEventRefs = [];
    dbg("canvas presence cleanup", this.doc.path);
    this.presenceCleanup?.();
    this.presenceCleanup = null;
    // Only restore when we're still the top patch. If another binding patched
    // over us (the canvas instance is shared across files in a leaf), leave
    // the chain intact — its closure delegates to the save it captured, and
    // our capture path is disabled by nulling `canvas`/`view` below.
    if (this.canvas && this.originalRequestSave) {
      if (this.canvas.requestSave === this.patchedRequestSave) {
        this.canvas.requestSave = this.originalRequestSave;
      }
    }
    this.canvas = null;
    this.adapter = null;
    this.view = null;
    this.originalRequestSave = null;
    this.patchedRequestSave = null;
    this.lastImportedHash = null;
    this.shadow = null;
  }

  private prioritizeAttachments(canvas: StructuredCanvas): void {
    const referencedPaths = canvasAttachmentPaths(canvas);
    const paths = this.plugin.vaultSync?.canvasBinaryPaths(referencedPaths) ?? [];
    const next = new Set(paths);
    const added = paths.filter((path) => !this.attachmentPaths.has(path));
    const removed = [...this.attachmentPaths].filter((path) => !next.has(path));
    this.plugin.vaultSync?.unprioritizeCanvasAttachments(removed);
    this.plugin.vaultSync?.prioritizeCanvasAttachments(added);
    this.attachmentPaths = next;
    this.renderAttachmentIndicator();
  }

  private renderAttachmentIndicator(): void {
    const missing = [...this.attachmentPaths].filter(
      (path) => !this.plugin.app.vault?.getAbstractFileByPath(path),
    );
    if (!missing.length) {
      this.attachmentIndicator?.remove();
      this.attachmentIndicator = null;
      return;
    }
    const host = this.host;
    if (!this.attachmentIndicator && host) {
      const indicator = document.createElement("div");
      indicator.className = "realtime-canvas-attachment-status";
      Object.assign(indicator.style, {
        position: "absolute",
        left: "12px",
        bottom: "12px",
        zIndex: "50",
        padding: "4px 8px",
        borderRadius: "4px",
        background: "var(--background-secondary)",
        color: "var(--text-muted)",
        fontSize: "12px",
        pointerEvents: "none",
      });
      host.append(indicator);
      this.attachmentIndicator = indicator;
    }
    if (this.attachmentIndicator) {
      this.attachmentIndicator.textContent = `Loading ${missing.length} Canvas attachment${missing.length === 1 ? "" : "s"}…`;
    }
  }

  private bindInteractionLifecycle(host: HTMLElement): void {
    const start = () => this.startInteraction();
    const finish = () => this.stopInteraction(true);
    const move = () => {
      if (!this.interactionActive || this.presenceRaf !== null) return;
      this.presenceRaf = requestAnimationFrame(() => {
        this.presenceRaf = null;
        this.publishPresence(true);
      });
    };
    const onVisibility = () => {
      if (document.hidden) finish();
    };
    host.addEventListener("pointerdown", start, true);
    host.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("blur", finish);
    document.addEventListener("visibilitychange", onVisibility);
    this.lifecycleCleanup = () => {
      host.removeEventListener("pointerdown", start, true);
      host.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("blur", finish);
      document.removeEventListener("visibilitychange", onVisibility);
      if (this.presenceRaf !== null) cancelAnimationFrame(this.presenceRaf);
      this.presenceRaf = null;
    };
  }

  private startInteraction(): void {
    if (this.interactionActive || !this.canvas || this.isStaleView()) return;
    this.interactionActive = true;
    this.publishPresence(true);
    // Sampling is durable but bounded. Awareness handles smooth pointer motion.
    this.interactionTimer = setInterval(() => this.captureLocal(), 75);
  }

  private stopInteraction(captureFinal: boolean): void {
    if (this.interactionTimer) clearInterval(this.interactionTimer);
    this.interactionTimer = null;
    const wasActive = this.interactionActive;
    this.interactionActive = false;
    if (captureFinal && wasActive) this.captureLocal();
    if (wasActive) this.publishPresence(false);
    if (this.remotePending) {
      this.remotePending = false;
      if (this.remoteTimer) clearTimeout(this.remoteTimer);
      this.remoteTimer = null;
      this.applyRemote();
    }
  }

  private publishPresence(interacting: boolean): void {
    const canvas = this.canvas;
    if (!canvas) {
      setCanvasPresence(this.doc.awareness, null);
      return;
    }
    const data = normalizeCanvas(canvas.getData());
    const selectedNodeIds = selectedIds(canvas).filter((id) => id in data.nodes);
    const viewport = readCanvasViewport(canvas);
    const interactionNodes = selectedNodeIds.flatMap((id) => {
      const node = data.nodes[id];
      if (!node || typeof node !== "object" || Array.isArray(node)) return [];
      const { x, y, width, height } = node;
      if ([x, y, width, height].some((value) => typeof value !== "number")) return [];
      return [
        { id, x: x as number, y: y as number, width: width as number, height: height as number },
      ];
    });
    setCanvasPresence(this.doc.awareness, {
      version: 1,
      sequence: ++this.presenceSequence,
      ...(selectedNodeIds.length ? { selectedNodeIds } : {}),
      ...(interacting && interactionNodes.length
        ? { interaction: { kind: "drag" as const, nodes: interactionNodes } }
        : {}),
      ...(this.editingNodeId ? { editingNodeId: this.editingNodeId } : {}),
      ...(viewport ? { viewport: { x: viewport.x, y: viewport.y, scale: viewport.scale } } : {}),
    });
  }

  private captureLocal(): void {
    try {
      if (!this.canvas) return;
      // The reused view may now show a different file: its data belongs to
      // that file, not this document. Folding it in would overwrite this
      // canvas everywhere with the other canvas's content.
      if (this.isStaleView()) {
        this.unpatch();
        return;
      }
      // Saves can fire while Obsidian is still mounting/reusing a canvas view.
      // Before startup reconcile, that snapshot may be stale data from a
      // previous path; disk startup handling is the source of truth until ready.
      if (!this.doc.isReady()) return;
      const data = this.canvas.getData();
      this.prioritizeAttachments(normalizeCanvas(data));
      if (!data) return;
      // Ignore the bounce-back from our own importData(): if the view still
      // shows exactly what we just pushed, it's not a local edit. Obsidian's
      // requestSave is debounced and may fire after applyingRemote has been
      // reset, so the flag alone is insufficient.
      const dataHash = hashCanvasData(data);
      if (this.lastImportedHash !== null && dataHash === this.lastImportedHash) return;
      this.lastImportedHash = null;
      const next = normalizeCanvas(data);
      if (this.shadow && typeof this.doc.applyCanvasOperations === "function") {
        const operations: CanvasOperation[] = diffCanvas(this.shadow, next);
        if (operations.length) {
          dbg("canvas local operation batch", this.doc.path, operations.length);
          this.doc.applyCanvasOperations(operations, CANVAS_LOCAL_ORIGIN);
        }
      } else {
        this.doc.reconcileFromCanvasData(data, CANVAS_LOCAL_ORIGIN);
      }
      this.shadow = next;
    } catch (e) {
      console.error(`[Realtime] failed to capture canvas update for ${this.doc.path}`, e);
    }
  }

  private findOpenCanvas(): BoundCanvasView | null {
    let found: BoundCanvasView | null = null;
    const inspect = (leaf: any) => {
      if (found) return;
      const view = leaf?.view;
      if (view?.getViewType?.() !== "canvas" || view?.file?.path !== this.doc.path) return;
      const canvas = view.canvas;
      if (isInternalCanvas(canvas)) found = { canvas, host: view.containerEl, view };
      else if (!loggedUnsupported) {
        loggedUnsupported = true;
        console.warn(
          "[Realtime] Obsidian canvas private API shape is unsupported; using disk write-through fallback.",
        );
      }
    };

    const workspace = this.plugin.app.workspace as any;
    workspace?.iterateAllLeaves?.(inspect);
    for (const leaf of workspace?.getLeavesOfType?.("canvas") ?? []) inspect(leaf);
    return found;
  }
}

function isInternalCanvas(value: unknown): value is InternalCanvas {
  const canvas = value as Partial<InternalCanvas> | null;
  // importData is required: without it applyRemote() can't push CRDT changes
  // into the view, and shouldDeferToLiveBinding() (which gates disk
  // write-through) must not suppress disk writes when remote apply is
  // impossible. Requiring it here means isActive() implies "can both capture
  // local edits AND apply remote updates" — the only configuration worth
  // patching for. If importData is missing we fall back to disk write-through
  // entirely, matching the logged warning.
  return (
    !!canvas &&
    typeof canvas.getData === "function" &&
    typeof canvas.requestSave === "function" &&
    typeof canvas.importData === "function"
  );
}

function selectedIds(canvas: InternalCanvas): string[] {
  const selection = canvas.selection;
  if (!(selection instanceof Set) && !(selection instanceof Map)) return [];
  const values = selection instanceof Map ? selection.keys() : selection.values();
  const ids: string[] = [];
  for (const value of values) {
    if (typeof value === "string") ids.push(value);
    else if (
      value &&
      typeof value === "object" &&
      typeof (value as { id?: unknown }).id === "string"
    )
      ids.push((value as { id: string }).id);
  }
  return [...new Set(ids)].sort();
}

const loggedAdapterFallbacks = new Set<string>();

function logAdapterFallback(reason: string, error?: unknown): void {
  const shape = error instanceof Error ? `${reason}:${error.name}:${error.message}` : reason;
  if (loggedAdapterFallbacks.has(shape)) return;
  loggedAdapterFallbacks.add(shape);
  if (error)
    console.warn("[Realtime] Canvas incremental API failed; using full import fallback.", error);
  else
    console.warn(
      "[Realtime] Canvas incremental API shape is unsupported; using full import fallback.",
    );
}

/**
 * Ordering calls are not stable across Obsidian versions. Adds append and
 * deletes retain relative order, so only discard order operations when those
 * ordinary mutations imply the exact requested order.
 */
function incrementalOperations(
  previous: StructuredCanvas,
  next: StructuredCanvas,
): CanvasOperation[] | null {
  const operations = diffCanvas(previous, next);
  const safeNodeOrder = impliedOrder(previous.nodeOrder, next.nodeOrder);
  const safeEdgeOrder = impliedOrder(previous.edgeOrder, next.edgeOrder);
  if (!safeNodeOrder || !safeEdgeOrder) return null;
  return operations.filter(
    (operation) => operation.type !== "node-order" && operation.type !== "edge-order",
  );
}

function impliedOrder(previous: readonly string[], next: readonly string[]): boolean {
  const nextIds = new Set(next);
  const previousIds = new Set(previous);
  const implied = previous.filter((id) => nextIds.has(id));
  for (const id of next) if (!previousIds.has(id)) implied.push(id);
  return implied.length === next.length && implied.every((id, index) => id === next[index]);
}

export function canvasAttachmentPaths(canvas: StructuredCanvas): string[] {
  const paths = new Set<string>();
  for (const value of Object.values(canvas.nodes)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.type === "file" &&
      typeof value.file === "string" &&
      value.file
    ) {
      paths.add(value.file);
    }
  }
  return [...paths].sort();
}

/**
 * Normalize canvas data through the parser so field reordering or default
 * additions by Obsidian's view don't defeat the equality check. Both
 * {@link applyRemote} and {@link captureLocal} hash through this so the
 * comparison is stable regardless of which side produced the snapshot.
 */
function hashCanvasData(data: unknown): string {
  try {
    const parsed = parseCanvas(JSON.stringify(data ?? {}));
    return JSON.stringify({
      n: Object.keys(parsed.nodes).sort(),
      e: Object.keys(parsed.edges).sort(),
      // Include field-level content so a real local edit (e.g. a node move)
      // is NOT mistaken for the bounce-back even when the id sets match.
      nodes: parsed.nodes,
      edges: parsed.edges,
    });
  } catch {
    return "";
  }
}
