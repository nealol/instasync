import type RealtimePlugin from "./main";
import { StructuredDocument, DISK_ORIGIN } from "./StructuredDocument";
import { CanvasBinding, CANVAS_LOCAL_ORIGIN } from "./editor/CanvasBinding";
import {
  isStructuredCanvas,
  parseCanvas,
  reconcileCanvas,
  serializeCanvas,
  type StructuredCanvas,
} from "./structured/canvas";
import type { JsonValue } from "./structured/reconcile";

const EMPTY_CANVAS: StructuredCanvas = { nodes: {}, edges: {}, nodeOrder: [], edgeOrder: [] };

export class CanvasDocument extends StructuredDocument {
  private binding: CanvasBinding;

  constructor(
    plugin: RealtimePlugin,
    path: string,
    guid: string,
    serverDocId: string,
    isCreator: boolean,
    opts: { autoConnect?: boolean } = {},
  ) {
    super(plugin, path, guid, serverDocId, isCreator, opts);
    this.binding = new CanvasBinding(plugin, this);
    this.binding.tryBind();
  }

  reconcileFromCanvasData(data: unknown, origin: unknown): void {
    this.applyValue(parseCanvas(JSON.stringify(data ?? {})), origin);
  }

  canvasData(): unknown {
    return JSON.parse(serializeCanvas(this.value));
  }

  tryBindLiveCanvas(): void {
    this.binding.tryBind();
  }

  // Suppress disk write-through only while a live binding is actually patched
  // onto an open canvas view. If the binding couldn't attach (unsupported
  // private API, view not yet mounted), the disk write-through stays active so
  // remote updates still land on disk instead of being silently dropped.
  protected shouldDeferToLiveBinding(): boolean {
    return this.binding.isActive();
  }

  protected parse(text: string): JsonValue {
    return parseCanvas(text);
  }

  protected serialize(value: JsonValue): string {
    return serializeCanvas(value);
  }

  // Use the tombstone-aware canvas reconciler instead of the generic
  // last-writer-wins map reconcile, so a stale full snapshot from a device
  // that hasn't applied a remote delete can't resurrect a tombstoned
  // node/edge. The local clientID is passed so same-device re-add (undo)
  // clears the tombstone while cross-device stale snapshots are blocked.
  protected applyValue(value: JsonValue, origin: unknown = DISK_ORIGIN): void {
    const incoming = isStructuredCanvas(value) ? value : (EMPTY_CANVAS as StructuredCanvas);
    this.ydoc.transact(() => reconcileCanvas(this.root, incoming, this.ydoc.clientID), origin);
  }

  protected onRootChanged(origin?: unknown): void {
    super.onRootChanged(origin);
    // Don't bounce our own just-captured canvas edit back into the live view —
    // that would re-import mid-drag and disrupt the selection. Remote edits
    // (and disk folds) carry a different origin and do get applied.
    if (origin === CANVAS_LOCAL_ORIGIN) return;
    this.binding.applyRemote();
  }

  protected destroySubclass(): void {
    this.binding.destroy();
    super.destroySubclass();
  }
}
