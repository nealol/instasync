import type * as Y from "yjs";
import { applyTextToYText } from "../diff";

export interface TextEditorAdapter {
  getText(): string;
  applyText(text: string): void;
  onChange(listener: () => void): () => void;
}

export interface YTextBindingReadiness {
  whenReady(): Promise<void>;
  isReady(): boolean;
  mayPushToShared(sharedEmpty: boolean): boolean;
}

/** Transport- and editor-independent two-way binding for one editor and one Y.Text. */
export class YTextEditorBinding {
  private destroyed = false;
  private ready = false;
  private readonly editorAtBind: string;
  private readonly removeEditorListener: () => void;
  private readonly yObserver: () => void;

  constructor(
    private readonly editor: TextEditorAdapter,
    private readonly ytext: Y.Text,
    private readonly readiness: YTextBindingReadiness,
    private readonly origin: unknown = null,
  ) {
    this.editorAtBind = editor.getText();
    this.yObserver = () => this.pullFromShared();
    ytext.observe(this.yObserver);
    this.removeEditorListener = editor.onChange(() => this.pushFromEditor());
    void readiness.whenReady().then(() => {
      if (this.destroyed) return;
      this.ready = true;
      this.reconcileOnAttach();
    });
  }

  private reconcileOnAttach(): void {
    const shared = this.ytext.toString();
    const current = this.editor.getText();
    if (shared === current) return;
    if (current !== this.editorAtBind && this.mayPush()) {
      this.writeShared(current);
    } else if (shared.length > 0) {
      this.editor.applyText(shared);
    } else if (current.length > 0 && this.mayPush()) {
      this.writeShared(current);
    }
  }

  private mayPush(): boolean {
    return this.readiness.mayPushToShared(this.ytext.length === 0);
  }

  private pullFromShared(): void {
    if (this.destroyed || !this.ready) return;
    const target = this.ytext.toString();
    if (this.editor.getText() !== target) this.editor.applyText(target);
  }

  private pushFromEditor(): void {
    if (this.destroyed || !this.ready || !this.readiness.isReady()) return;
    const target = this.editor.getText();
    if (target === this.ytext.toString() || !this.mayPush()) return;
    this.writeShared(target);
  }

  private writeShared(target: string): void {
    this.ytext.doc?.transact(() => applyTextToYText(this.ytext, target), this.origin ?? this);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.removeEditorListener();
    this.ytext.unobserve(this.yObserver);
  }
}
