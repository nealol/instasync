import type RealtimePlugin from "../main";
import type { CanvasDocument } from "../CanvasDocument";
import { parseCanvas } from "../structured/canvas";

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
}

export class CanvasBinding {
  private plugin: RealtimePlugin;
  private doc: CanvasDocument;
  private canvas: InternalCanvas | null = null;
  private originalRequestSave: InternalCanvas["requestSave"] | null = null;
  private applyingRemote = false;
  /**
   * Normalized snapshot of the last data pushed into the view via
   * {@link applyRemote}. Obsidian's `requestSave` is debounced and may fire
   * *after* {@link applyingRemote} has been reset, so the flag alone can't
   * suppress that bounce-back. Comparing the captured data against this hash
   * ignores it precisely without muting a genuine concurrent local edit.
   */
  private lastImportedHash: string | null = null;

  constructor(plugin: RealtimePlugin, doc: CanvasDocument) {
    this.plugin = plugin;
    this.doc = doc;
  }

  /** True only while we're patched onto a live, recognized canvas view. */
  isActive(): boolean {
    return this.canvas !== null;
  }

  tryBind(): void {
    const canvas = this.findOpenCanvas();
    // Same live canvas we are already patched onto — nothing to do.
    if (canvas && canvas === this.canvas) return;
    // The leaf was closed (canvas == null) or reopened as a fresh Canvas
    // instance: drop the stale patch before binding the new one, so live
    // editing survives close/reopen instead of silently dying.
    if (this.canvas && canvas !== this.canvas) this.unpatch();
    if (!canvas) return;
    this.canvas = canvas;
    this.originalRequestSave = canvas.requestSave.bind(canvas);
    canvas.requestSave = (...args: unknown[]) => {
      const result = this.originalRequestSave?.(...args);
      if (!this.applyingRemote) this.captureLocal();
      return result;
    };
    this.applyRemote();
  }

  /** Push the CRDT's current value into the live view and converge disk. */
  applyRemote(): void {
    if (!this.canvas) return;
    const next = this.doc.canvasData();
    const nextHash = hashCanvasData(next);
    // Skip a pointless re-render (and the scroll/selection churn it brings)
    // when the live view already shows this content. Still stamp the hash so
    // a delayed requestSave triggered by the *previous* import is ignored.
    if (hashCanvasData(this.canvas.getData()) === nextHash) {
      this.lastImportedHash = nextHash;
      return;
    }
    this.applyingRemote = true;
    this.lastImportedHash = nextHash;
    try {
      // Pass clear=true so importData REMOVES nodes/edges absent from the
      // CRDT snapshot, not just adds/updates. Without it, deleted edges never
      // leave the live view — the original "deleted edges not propagating" bug.
      this.canvas.importData(next, true);
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

  destroy(): void {
    this.unpatch();
  }

  /** Restore the canvas's original `requestSave` and forget the binding. */
  private unpatch(): void {
    if (this.canvas && this.originalRequestSave) {
      this.canvas.requestSave = this.originalRequestSave;
    }
    this.canvas = null;
    this.originalRequestSave = null;
    this.lastImportedHash = null;
  }

  private captureLocal(): void {
    try {
      const data = this.canvas?.getData();
      if (!data) return;
      // Ignore the bounce-back from our own importData(): if the view still
      // shows exactly what we just pushed, it's not a local edit. Obsidian's
      // requestSave is debounced and may fire after applyingRemote has been
      // reset, so the flag alone is insufficient.
      const dataHash = hashCanvasData(data);
      if (this.lastImportedHash !== null && dataHash === this.lastImportedHash) return;
      this.lastImportedHash = null;
      this.doc.reconcileFromCanvasData(data, CANVAS_LOCAL_ORIGIN);
    } catch (e) {
      console.error(`[Realtime] failed to capture canvas update for ${this.doc.path}`, e);
    }
  }

  private findOpenCanvas(): InternalCanvas | null {
    let found: InternalCanvas | null = null;
    const inspect = (leaf: any) => {
      if (found) return;
      const view = leaf?.view;
      if (view?.getViewType?.() !== "canvas" || view?.file?.path !== this.doc.path) return;
      const canvas = view.canvas;
      if (isInternalCanvas(canvas)) found = canvas;
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
