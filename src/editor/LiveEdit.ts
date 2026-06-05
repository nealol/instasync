// Binds an Obsidian (CodeMirror 6) editor to a Yjs Y.Text, in both directions.
// Adapted from y-codemirror.next (MIT, © Kevin Jahns) and the Relay plugin.

import type { ChangeSpec } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type * as Y from "yjs";
import type { Document } from "../Document";
import { getDocumentForEditor } from "./context";
import { ySyncAnnotation } from "./annotations";
import { applyTextToYText } from "../diff";
import { dbg, snip } from "../debug";

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
		dbg("applyTextToEditor", this.doc?.path, "editor", snip(current), "->ytext", snip(target));

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

		// Self-healing reconcile: make ytext match the editor's *current* text via a
		// minimal prefix/suffix diff, instead of mapping CodeMirror change offsets
		// onto ytext positions. Offset-mapping silently corrupts (and duplicates
		// characters) the moment ytext and the editor drift apart — e.g. when a
		// single ViewUpdate bundles an applied-remote change with a user keystroke.
		// This approach can't drift: it is idempotent for the remote changes we
		// ourselves applied (ytext already equals the editor, so it no-ops), which
		// is also why it needs no annotation filter.
		const target = update.state.doc.toString();
		if (this.ytext.toString() === target) return;
		dbg("local push", this.doc?.path, "ytext", snip(this.ytext.toString()), "->editor", snip(target));
		applyTextToYText(this.ytext, target, this);
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
