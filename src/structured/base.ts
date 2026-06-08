import YAML from "yaml";
import type { JsonValue } from "./reconcile";

export function parseBase(text: string): JsonValue {
	const parsed = text.trim() ? YAML.parse(text) : {};
	return normalizeJson(parsed);
}

export function serializeBase(value: JsonValue): string {
	return YAML.stringify(value ?? {})
}

function normalizeJson(value: unknown): JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) return value.map(normalizeJson);
	if (typeof value === "object" && value) {
		const out: Record<string, JsonValue> = {};
		for (const [key, child] of Object.entries(value)) out[key] = normalizeJson(child);
		return out;
	}
	return null;
}
