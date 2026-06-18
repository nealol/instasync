/**
 * Shared types for the synced-SQLite plugin database layer.
 *
 * The wire format (used identically in the per-DB Y.Doc batches and in the
 * server bootstrap/changes endpoint) is intentionally JSON-friendly so it can
 * live inside Yjs `Any` values and be parsed by serde on the Rust side:
 *
 *  - `pk` and `siteId` are 16-byte / composite **binary** blobs, base64-encoded.
 *  - a change `val` is one of: JSON null | number | string | boolean, or a
 *    tagged object `{ "$blob": base64 }` for blob values, or `{ "$int": "decimal" }`
 *    for 64-bit integers that may exceed JS safe-integer range.
 *
 * The `pk` column is an opaque, binary-encoded composite key — never reinterpret
 * it; round-trip it as bytes only.
 */

/** A value as bound to / returned from wa-sqlite. */
export type SqlValue = null | number | bigint | string | Uint8Array | boolean;

/** Tagged, JSON-safe encoding of a single `crsql_changes.val`. */
export type EncodedVal = null | number | string | boolean | { $blob: string } | { $int: string };

/**
 * One row of the `crsql_changes` virtual table, with binary columns base64
 * encoded. This is the atom of replication: reading produces these, and
 * `INSERT INTO crsql_changes` *merges* them.
 */
export interface ChangeRow {
  /** Source table name (quoted as `"table"` in SQL — a reserved word). */
  table: string;
  /** base64 of the binary-encoded composite primary key (opaque). */
  pk: string;
  /** Column id / sentinel. */
  cid: string;
  /** Encoded column value. */
  val: EncodedVal;
  /** Per-column lamport version. */
  col_version: number;
  /** Per-database lamport clock at which this change was made. */
  db_version: number;
  /** base64 of the 16-byte originating site id. */
  site_id: string;
  /** Causal length (whole-row create/delete resolution). */
  cl: number;
  /** Intra-change sequence. */
  seq: number;
}

/** A published batch of changes, stored as one entry in the per-DB doc array. */
export interface Batch {
  /** Unique batch id (ULID-ish, monotonic-ish, collision-resistant). */
  id: string;
  /** Hex site id of the device that produced these changes. */
  siteId: string;
  /** Exclusive lower bound of `db_version`s covered (cursor before append). */
  fromDbVersion: number;
  /** Inclusive upper bound of `db_version`s covered. */
  toDbVersion: number;
  /** Schema version the producing client was at. */
  schemaVersion: number;
  /** The change rows. */
  changes: ChangeRow[];
  /** Creation time (ms epoch). */
  createdAt: number;
  /**
   * Compatibility tag pinning the cr-sqlite sync format. Clients refuse to
   * apply batches whose `format` they do not understand.
   */
  format: string;
}

/** Per-device applied cursor: max db_version seen per origin site id. */
export type Cursor = Record<string, number>;

/** Lifecycle state surfaced to plugin authors via `onStateChange`. */
export type DbState =
  | "loading-wasm"
  | "restoring"
  | "bootstrapping"
  | "syncing"
  | "live"
  | "offline"
  | "needs-migration"
  | "error";

/** Reason attached to a terminal `error` state. */
export type DbErrorReason = "deleted" | "diverged" | "wasm" | "signed-out" | "unknown";

/** Payload for `onRemoteChange`. */
export interface RemoteChange {
  /** Distinct table names touched by the applied remote batch group. */
  tables: string[];
}
