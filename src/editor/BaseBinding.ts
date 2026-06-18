import type RealtimePlugin from "../main";
import type { BaseDocument } from "../BaseDocument";

/**
 * Origin tag stamped on the Yjs transaction when we fold a local base edit
 * (captured via the patched `requestSave`) into the CRDT. The document's root
 * observer uses it to avoid re-pushing our own edit back into the live view.
 */
export const BASE_LOCAL_ORIGIN = Symbol("realtime-base-request-save");
let loggedUnsupported = false;

/**
 * The Bases file view is a {@link https://docs.obsidian.md/Reference/TypeScript+API/TextFileView TextFileView}
 * subclass, so it exposes the same load/save shape every text-backed view does:
 *
 *  - `getViewData()` serializes the live view state back to `.base` YAML;
 *  - `setViewData(data, clear)` loads YAML into the view and re-renders in place;
 *  - `requestSave()` is the debounced choke point through which every local edit
 *    is persisted.
 *
 * We mirror {@link CanvasBinding} exactly, just against this standard API rather
 * than the canvas-specific private one.
 */
interface InternalBaseView {
  file?: { path?: string } | null;
  getViewType?: () => string;
  getViewData: () => string;
  setViewData: (data: string, clear: boolean) => void;
  requestSave: () => void;
}

export class BaseBinding {
  private plugin: RealtimePlugin;
  private doc: BaseDocument;
  private view: InternalBaseView | null = null;
  private originalRequestSave: InternalBaseView["requestSave"] | null = null;
  private applyingRemote = false;

  constructor(plugin: RealtimePlugin, doc: BaseDocument) {
    this.plugin = plugin;
    this.doc = doc;
  }

  /** True only while we're patched onto a live, recognized Bases view. */
  isActive(): boolean {
    return this.view !== null;
  }

  tryBind(): void {
    const view = this.findOpenBase();
    // Same live view we are already patched onto — nothing to do.
    if (view && view === this.view) return;
    // The leaf was closed (view == null) or reopened as a fresh instance:
    // drop the stale patch before binding the new one, so live editing
    // survives close/reopen instead of silently dying.
    if (this.view && view !== this.view) this.unpatch();
    if (!view) return;
    this.view = view;
    this.originalRequestSave = view.requestSave.bind(view);
    view.requestSave = () => {
      const result = this.originalRequestSave?.();
      if (!this.applyingRemote) this.captureLocal();
      return result;
    };
    this.applyRemote();
  }

  /** Push the CRDT's current value into the live view and persist it. */
  applyRemote(): void {
    if (!this.view) return;
    const next = this.doc.baseData();
    // Avoid a pointless re-render (and the scroll/selection churn it brings)
    // when the view already shows this content.
    if (this.view.getViewData() === next) return;
    this.applyingRemote = true;
    try {
      this.view.setViewData(next, false);
      // Converge disk too: while the view is open the StructuredDocument
      // write-through is suppressed in favor of this binding.
      this.originalRequestSave?.();
    } catch (e) {
      console.error(`[Realtime] failed to apply base update for ${this.doc.path}`, e);
    } finally {
      this.applyingRemote = false;
    }
  }

  destroy(): void {
    this.unpatch();
  }

  /** Restore the view's original `requestSave` and forget the binding. */
  private unpatch(): void {
    if (this.view && this.originalRequestSave) {
      this.view.requestSave = this.originalRequestSave;
    }
    this.view = null;
    this.originalRequestSave = null;
  }

  private captureLocal(): void {
    try {
      const data = this.view?.getViewData();
      if (typeof data === "string") this.doc.reconcileFromBaseText(data, BASE_LOCAL_ORIGIN);
    } catch (e) {
      console.error(`[Realtime] failed to capture base update for ${this.doc.path}`, e);
    }
  }

  private findOpenBase(): InternalBaseView | null {
    let found: InternalBaseView | null = null;
    const inspect = (leaf: any) => {
      if (found) return;
      const view = leaf?.view;
      if (view?.file?.path !== this.doc.path) return;
      if (view?.getViewType?.() !== "bases") return;
      if (isInternalBaseView(view)) found = view;
      else if (!loggedUnsupported) {
        loggedUnsupported = true;
        console.warn(
          "[Realtime] Obsidian Bases view API shape is unsupported; using disk write-through fallback.",
        );
      }
    };

    const workspace = this.plugin.app.workspace as any;
    workspace?.iterateAllLeaves?.(inspect);
    for (const leaf of workspace?.getLeavesOfType?.("bases") ?? []) inspect(leaf);
    return found;
  }
}

function isInternalBaseView(value: unknown): value is InternalBaseView {
  const view = value as Partial<InternalBaseView> | null;
  return (
    !!view &&
    typeof view.getViewData === "function" &&
    typeof view.setViewData === "function" &&
    typeof view.requestSave === "function"
  );
}
