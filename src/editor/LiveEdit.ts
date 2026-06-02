// Binds an Obsidian (CodeMirror 6) editor to a Yjs Y.Text, in both directions.
// Adapted from y-codemirror.next (MIT, © Kevin Jahns) and the Relay plugin.

import type { ChangeSpec } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type * as Y from "yjs";
import type { Document } from "../Document";
import { getDocumentForEditor } from "./context";
import { ySyncAnnotation } from "./annotations";

class LiveEditPluginValue implements PluginValue {
	private editor: EditorView;
	private doc: Document | null = null;
	private ytext: Y.Text | null = null;
	private observer: (() => void) | null = null;
	private destroyed = false;
	private retries = 0;

	constructor(editor: EditorView) {
		this.editor = editor;
		this.tryBind();
	}

	/** Attempt to find this file's Document and attach. Retries until sync is ready. */
	private tryBind(): void {
		if (this.destroyed || this.doc) return;
		const doc = getDocumentForEditor(this.editor);
		if (!doc) {
			if (this.retries++ < 50) {
				window.setTimeout(() => this.tryBind(), 200);
			}
			return;
		}
		this.doc = doc;
		this.ytext = doc.ytext;
		doc.bindEditor();

		const observer = () => this.onYTextChanged();
		this.observer = observer;
		this.ytext.observe(observer);

		// Reconcile only after initial sync, so we never act on an empty,
		// not-yet-synced shared document.
		void doc.whenReady().then(() => {
			if (this.destroyed) return;
			this.reconcileOnAttach();
		});
	}

	/**
	 * Align the editor and the shared text when an editor attaches:
	 *  - if the shared text has content, it is authoritative -> update editor;
	 *  - else if the editor has content, seed the shared text from it;
	 *  - if both are empty, do nothing.
	 * We never overwrite editor content with an empty shared document.
	 */
	private reconcileOnAttach(): void {
		if (!this.ytext || this.destroyed) return;
		const shared = this.ytext.toString();
		const current = this.editor.state.doc.toString();
		if (shared === current) return;

		if (shared.length > 0) {
			this.applyTextToEditor(shared);
		} else if (current.length > 0) {
			const ytext = this.ytext;
			ytext.doc?.transact(() => {
				ytext.insert(0, current);
			}, this);
		}
	}

	/** Apply a remote Yjs change to the editor. */
	private onYTextChanged(): void {
		if (!this.ytext || this.destroyed) return;
		// Re-derive the editor content from the shared text using a minimal diff.
		// (Using delta would be more precise, but observe() here is invoked without
		// the event; we recompute against the current editor text instead.)
		this.applyTextToEditor(this.ytext.toString());
	}

	private applyTextToEditor(target: string): void {
		const current = this.editor.state.doc.toString();
		if (current === target) return;

		// Minimal prefix/suffix diff so we don't disturb the local selection.
		let start = 0;
		const max = Math.min(current.length, target.length);
		while (start < max && current[start] === target[start]) start++;
		let endCur = current.length;
		let endTar = target.length;
		while (endCur > start && endTar > start && current[endCur - 1] === target[endTar - 1]) {
			endCur--;
			endTar--;
		}
		const changes: ChangeSpec = {
			from: start,
			to: endCur,
			insert: target.slice(start, endTar),
		};
		this.editor.dispatch({
			changes,
			annotations: [ySyncAnnotation.of(this.editor)],
		});
	}

	/** Push local editor edits into the shared Y.Text. */
	update(update: ViewUpdate): void {
		if (this.destroyed) return;
		if (!this.doc) {
			this.tryBind();
			return;
		}
		if (!this.ytext || !update.docChanged) return;
		// Skip changes we produced ourselves from a Yjs update.
		if (
			update.transactions.length > 0 &&
			update.transactions.some((t) => t.annotation(ySyncAnnotation) === this.editor)
		) {
			return;
		}

		const ytext = this.ytext;
		ytext.doc?.transact(() => {
			let adj = 0;
			update.changes.iterChanges((fromA, toA, _fromB, _toB, insert) => {
				const insertText = insert.sliceString(0, insert.length, "\n");
				if (fromA !== toA) {
					ytext.delete(fromA + adj, toA - fromA);
				}
				if (insertText.length > 0) {
					ytext.insert(fromA + adj, insertText);
				}
				adj += insertText.length - (toA - fromA);
			});
		}, this);
	}

	destroy(): void {
		this.destroyed = true;
		if (this.observer && this.ytext) {
			this.ytext.unobserve(this.observer);
		}
		if (this.doc) {
			this.doc.unbindEditor();
		}
		this.observer = null;
		this.ytext = null;
		this.doc = null;
		this.editor = null as any;
	}
}

export const liveEdit = ViewPlugin.fromClass(LiveEditPluginValue);
