/**
 * Shared types for the synced-SQLite plugin database layer.
 *
 * The public type definitions live in `@realtime-md/plugin-api-types` (the
 * published types package); this module re-exports them for internal use and
 * keeps the runtime validation values that are not part of the public surface.
 */

export type {
  SqlValue,
  EncodedVal,
  ChangeRow,
  Batch,
  Cursor,
  DbState,
  DbErrorReason,
  RemoteChange,
} from "@realtime-md/plugin-api-types";

/** Current sync wire/format version. Must match the server extension's major. */
export const SYNC_FORMAT = "crsqlite-1";

/**
 * Target change rows per published batch. Rows sharing one db_version remain
 * atomic and may exceed this target because cursors advance by db_version.
 */
export const MAX_BATCH_ROWS = 500;

/** `[A-Za-z0-9_-]{1,80}` — the validation rule for pluginId / name. */
export const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * True when an id is valid: matches {@link ID_RE} and contains no `__`.
 * (`__` is the separator inside doc ids — `{vault}__plugindb__{plugin}__{name}`
 * — so allowing it would make those ids ambiguous to parse.)
 */
export function isValidId(id: string): boolean {
  return ID_RE.test(id) && !id.includes("__");
}
