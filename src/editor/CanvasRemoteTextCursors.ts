import { Annotation, Compartment, RangeSet, StateEffect, type Range } from "@codemirror/state";
import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { readCanvasPresence } from "../presence";

const refresh = Annotation.define<boolean>();

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

class CanvasRemoteTextCursorPlugin {
  decorations: DecorationSet = RangeSet.of([]);
  private destroyed = false;
  private readonly listener: (change: AwarenessChange) => void;

  constructor(
    private readonly view: EditorView,
    private readonly ytext: Y.Text,
    private readonly awareness: Awareness,
    private readonly nodeId: string,
  ) {
    this.listener = ({ added, updated, removed }) => {
      if (added.concat(updated, removed).some((id) => id !== awareness.doc.clientID)) {
        view.dispatch({ annotations: refresh.of(true) });
      }
    };
    awareness.on("change", this.listener);
  }

  update(update: ViewUpdate): void {
    const ydoc = this.ytext.doc;
    if (!ydoc) return;
    const localState = this.awareness.getLocalState();
    if (localState) {
      const focused = update.view.hasFocus && update.view.dom.ownerDocument.hasFocus();
      const selection = focused ? update.state.selection.main : null;
      if (selection) {
        const anchor = Y.createRelativePositionFromTypeIndex(this.ytext, selection.anchor);
        const head = Y.createRelativePositionFromTypeIndex(this.ytext, selection.head);
        const currentAnchor = localState.cursor?.anchor
          ? Y.createRelativePositionFromJSON(localState.cursor.anchor)
          : null;
        const currentHead = localState.cursor?.head
          ? Y.createRelativePositionFromJSON(localState.cursor.head)
          : null;
        if (
          !currentAnchor ||
          !currentHead ||
          !Y.compareRelativePositions(currentAnchor, anchor) ||
          !Y.compareRelativePositions(currentHead, head)
        ) {
          queueMicrotask(() => {
            if (!this.destroyed) this.awareness.setLocalStateField("cursor", { anchor, head });
          });
        }
      } else if (localState.cursor != null) {
        queueMicrotask(() => {
          if (!this.destroyed) this.awareness.setLocalStateField("cursor", null);
        });
      }
    }

    const ranges: Array<Range<Decoration>> = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.awareness.doc.clientID) return;
      const presence = readCanvasPresence(state.canvasPresence);
      if (presence?.editingNodeId !== this.nodeId) return;
      const cursor = state.cursor;
      if (!cursor?.anchor || !cursor?.head) return;
      const anchor = Y.createAbsolutePositionFromRelativePosition(cursor.anchor, ydoc);
      const head = Y.createAbsolutePositionFromRelativePosition(cursor.head, ydoc);
      if (!anchor || !head || anchor.type !== this.ytext || head.type !== this.ytext) return;
      if (anchor.index > update.state.doc.length || head.index > update.state.doc.length) return;
      const { color = "#30bced", name = "Anonymous" } = state.user ?? {};
      const colorLight = state.user?.colorLight ?? `${color}33`;
      const start = Math.min(anchor.index, head.index);
      const end = Math.max(anchor.index, head.index);
      if (start !== end) {
        ranges.push({
          from: start,
          to: end,
          value: Decoration.mark({
            class: "cm-ySelection",
            attributes: { style: `background-color: ${colorLight}` },
          }),
        });
      }
      ranges.push({
        from: head.index,
        to: head.index,
        value: Decoration.widget({
          side: head.index >= anchor.index ? -1 : 1,
          widget: new CanvasCaretWidget(color, name),
        }),
      });
    });
    this.decorations = Decoration.set(ranges, true);
  }

  destroy(): void {
    this.destroyed = true;
    this.awareness.off("change", this.listener);
  }
}

class CanvasCaretWidget extends WidgetType {
  constructor(
    private readonly color: string,
    private readonly name: string,
  ) {
    super();
  }

  eq(other: CanvasCaretWidget): boolean {
    return other.color === this.color && other.name === this.name;
  }

  toDOM(): HTMLElement {
    const caret = document.createElement("span");
    caret.className = "cm-ySelectionCaret";
    caret.style.backgroundColor = this.color;
    caret.style.borderColor = this.color;
    const label = document.createElement("span");
    label.className = "cm-ySelectionInfo";
    label.dataset.name = this.name;
    caret.append(label);
    return caret;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function mountCanvasRemoteTextCursors(
  view: EditorView,
  ytext: Y.Text,
  awareness: Awareness,
  nodeId: string,
): () => void {
  const compartment = new Compartment();
  const extension = ViewPlugin.define(
    (editor) => new CanvasRemoteTextCursorPlugin(editor, ytext, awareness, nodeId),
    { decorations: (plugin) => plugin.decorations },
  );
  view.dispatch({ effects: StateEffect.appendConfig.of(compartment.of(extension)) });
  return () => {
    awareness.setLocalStateField("cursor", null);
    view.dispatch({ effects: compartment.reconfigure([]) });
  };
}
