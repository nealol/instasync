import type { CanvasDocument } from "../CanvasDocument";
import { shouldPushEditorToShared } from "./LiveEdit";
import { discoverCanvasTextEditor } from "./CanvasTextEditorAdapter";
import { mountCanvasRemoteTextCursors } from "./CanvasRemoteTextCursors";
import { YTextEditorBinding } from "./YTextEditorBinding";

export class CanvasTextCardBinding {
  private timer: ReturnType<typeof setInterval> | null = null;
  private binding: YTextEditorBinding | null = null;
  private source: object | null = null;
  private nodeId: string | null = null;
  private cursorCleanup: (() => void) | null = null;

  constructor(
    private readonly doc: CanvasDocument,
    private readonly getCanvas: () => unknown,
    private readonly onActiveNode: (nodeId: string | null) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 200);
  }

  refresh(): void {
    const active = discoverCanvasTextEditor(this.getCanvas());
    if (!active) {
      this.detach();
      return;
    }
    if (active.source === this.source && active.nodeId === this.nodeId) return;
    this.detach();
    const ytext = this.doc.canvasNodeText(active.nodeId);
    if (!ytext) return;
    this.source = active.source;
    this.nodeId = active.nodeId;
    this.onActiveNode(active.nodeId);
    this.binding = new YTextEditorBinding(active.editor, ytext, {
      whenReady: () => this.doc.whenReady(),
      isReady: () => this.doc.isReady(),
      mayPushToShared: (sharedEmpty) =>
        shouldPushEditorToShared({
          sharedEmpty,
          isCreator: this.doc.isCreator,
          hasSyncedOnce: this.doc.hasSyncedOnce,
          providerOnline: this.doc.isProviderOnline,
        }),
    });
    if (active.view) {
      this.cursorCleanup = mountCanvasRemoteTextCursors(
        active.view,
        ytext,
        this.doc.awareness,
        active.nodeId,
      );
    }
  }

  private detach(): void {
    this.binding?.destroy();
    this.binding = null;
    this.cursorCleanup?.();
    this.cursorCleanup = null;
    this.source = null;
    if (this.nodeId !== null) this.onActiveNode(null);
    this.nodeId = null;
  }

  destroy(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
    this.detach();
  }
}
