import type InstaSyncPlugin from "./main";
import { StructuredDocument } from "./StructuredDocument";
import { parseBase, serializeBase } from "./structured/base";
import type { JsonValue } from "./structured/reconcile";

export class BaseDocument extends StructuredDocument {
	constructor(plugin: InstaSyncPlugin, path: string, guid: string, serverDocId: string, isCreator: boolean) {
		super(plugin, path, guid, serverDocId, isCreator);
	}

	protected parse(text: string): JsonValue {
		return parseBase(text);
	}

	protected serialize(value: JsonValue): string {
		return serializeBase(value);
	}
}
