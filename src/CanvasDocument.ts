import type RealtimePlugin from "./main";
import { StructuredDocument } from "./StructuredDocument";
import { CanvasBinding, CANVAS_LOCAL_ORIGIN } from "./editor/CanvasBinding";
import { parseCanvas, serializeCanvas } from "./structured/canvas";
import type { JsonValue } from "./structured/reconcile";

export class CanvasDocument extends StructuredDocument {
	private binding: CanvasBinding;

	constructor(plugin: RealtimePlugin, path: string, guid: string, serverDocId: string, isCreator: boolean) {
		super(plugin, path, guid, serverDocId, isCreator);
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

	protected parse(text: string): JsonValue {
		return parseCanvas(text);
	}

	protected serialize(value: JsonValue): string {
		return serializeCanvas(value);
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
