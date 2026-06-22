import * as Y from "yjs";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ReconcileOptions {
  textKeys?: Set<string>;
}

const DEFAULT_TEXT_KEYS = new Set([
  "text",
  "label",
  "filter",
  "formula",
  "query",
  "name",
  "description",
]);

function shouldUseText(
  key: string | undefined,
  value: unknown,
  options?: ReconcileOptions,
): boolean {
  if (typeof value !== "string") return false;
  const keys = options?.textKeys ?? DEFAULT_TEXT_KEYS;
  return !!key && (keys.has(key) || value.length > 256);
}

export function reconcileInto(
  parent: Y.Map<any> | Y.Array<any>,
  value: JsonValue,
  options: ReconcileOptions = {},
): void {
  if (parent instanceof Y.Map) {
    reconcileMap(parent, isRecord(value) ? value : {}, options);
  } else if (parent instanceof Y.Array) {
    reconcileArray(parent, Array.isArray(value) ? value : [], options);
  }
}

function reconcileMap(
  map: Y.Map<any>,
  value: Record<string, JsonValue>,
  options: ReconcileOptions,
): void {
  for (const key of Array.from(map.keys())) {
    if (!(key in value)) map.delete(key);
  }
  for (const [key, next] of Object.entries(value)) {
    const current = map.get(key);
    const reconciled = reconcileValue(current, next, key, options, (created) =>
      map.set(key, created),
    );
    if (map.get(key) !== reconciled) map.set(key, reconciled);
  }
}

export function reconcileArray(
  array: Y.Array<any>,
  value: JsonValue[],
  options: ReconcileOptions,
): void {
  let i = 0;
  for (; i < value.length; i++) {
    const current = array.get(i);
    const next = reconcileValue(current, value[i], undefined, options, (created) => {
      if (i < array.length) array.delete(i, 1);
      array.insert(i, [created]);
    });
    if (array.get(i) !== next) {
      if (i < array.length) array.delete(i, 1);
      array.insert(i, [next]);
    }
  }
  if (array.length > value.length) array.delete(value.length, array.length - value.length);
}

export function reconcileValue(
  current: any,
  next: JsonValue,
  key: string | undefined,
  options: ReconcileOptions,
  attach: (created: any) => void,
): any {
  if (Array.isArray(next)) {
    const array = current instanceof Y.Array ? current : attachAndReturn(new Y.Array(), attach);
    reconcileArray(array, next, options);
    return array;
  }
  if (isRecord(next)) {
    const map = current instanceof Y.Map ? current : attachAndReturn(new Y.Map(), attach);
    reconcileMap(map, next, options);
    return map;
  }
  if (shouldUseText(key, next, options)) {
    const text = current instanceof Y.Text ? current : attachAndReturn(new Y.Text(), attach);
    applyStringToYText(text, typeof next === "string" ? next : "");
    return text;
  }
  return next;
}

function attachAndReturn<T>(value: T, attach: (created: T) => void): T {
  attach(value);
  return value;
}

export function toValue(value: any): JsonValue {
  if (value instanceof Y.Map) {
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of value.entries()) out[key] = toValue(child);
    return out;
  }
  if (value instanceof Y.Array) return value.toArray().map((child) => toValue(child));
  if (value instanceof Y.Text) return value.toString();
  if (value === undefined) return null;
  return value as JsonValue;
}

function applyStringToYText(ytext: Y.Text, next: string): void {
  const old = ytext.toString();
  if (old === next) return;
  let prefix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  let oldSuffix = old.length;
  let nextSuffix = next.length;
  while (oldSuffix > prefix && nextSuffix > prefix && old[oldSuffix - 1] === next[nextSuffix - 1]) {
    oldSuffix--;
    nextSuffix--;
  }
  const deleteLen = oldSuffix - prefix;
  if (deleteLen > 0) ytext.delete(prefix, deleteLen);
  const insert = next.slice(prefix, nextSuffix);
  if (insert) ytext.insert(prefix, insert);
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
