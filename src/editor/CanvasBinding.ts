import type RealtimePlugin from "../main";
import type { CanvasDocument } from "../CanvasDocument";

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
	importData?: (data: unknown) => void;
	requestSave: (...args: unknown[]) => unknown;
	requestFrame?: () => void;
}

export class CanvasBinding {
	private plugin: RealtimePlugin;
	private doc: CanvasDocument;
	private canvas: InternalCanvas | null = null;
	private originalRequestSave: InternalCanvas["requestSave"] | null = null;
	private applyingRemote = false;

	constructor(plugin: RealtimePlugin, doc: CanvasDocument) {
		this.plugin = plugin;
		this.doc = doc;
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

	applyRemote(): void {
		if (!this.canvas?.importData) return;
		this.applyingRemote = true;
		try {
			this.canvas.importData(this.doc.canvasData());
			this.canvas.requestFrame?.();
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
	}

	private captureLocal(): void {
		try {
			const data = this.canvas?.getData();
			if (data) this.doc.reconcileFromCanvasData(data, CANVAS_LOCAL_ORIGIN);
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
				console.warn("[Realtime] Obsidian canvas private API shape is unsupported; using disk write-through fallback.");
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
	return !!canvas && typeof canvas.getData === "function" && typeof canvas.requestSave === "function";
}
