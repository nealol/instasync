import { Annotation } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * Marks editor transactions that were produced by applying a Yjs change, so the
 * local-change handler can skip re-sending them to the shared document.
 */
export const ySyncAnnotation = Annotation.define<EditorView>();
