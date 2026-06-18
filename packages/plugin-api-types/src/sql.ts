/**
 * Types for the synced-SQLite API, reachable as
 * `app.plugins.plugins["realtime"].sql`.
 *
 * See the docs/plugin-sql guide in the Realtime repository. The API is
 * intentionally small: `open`, `delete`, `restore`, `whenAvailable`, plus the
 * returned database handle.
 *
 * Identifier rule: `pluginId` and `name` must match `[A-Za-z0-9_-]{1,80}` and
 * must not contain `__` (the separator inside doc ids).
 */

import type { DbState, RemoteChange, SqlValue } from "./values";

/** A transaction handle passed to `migrate` and `transaction`. */
export interface SqlTx {
  exec(sql: string, bind?: SqlValue[]): Promise<void>;
  query<T = Record<string, SqlValue>>(sql: string, bind?: SqlValue[]): Promise<T[]>;
}

export type MigrateFn = (tx: SqlTx, fromVersion: number) => Promise<void>;

export interface OpenOptions {
  name: string;
  pluginId: string;
  schemaVersion: number;
  migrate: MigrateFn;
  /** Optional repair hook run after each remote apply (dedupe etc.). */
  onMergeReview?: (tables: string[]) => void | Promise<void>;
}

export interface DeleteOrRestoreOptions {
  pluginId: string;
  name: string;
}

/** The database handle returned by {@link RealtimeSql.open}. */
export interface DatabaseHandle {
  exec(sql: string, bind?: SqlValue[]): Promise<void>;
  query<T = Record<string, SqlValue>>(sql: string, bind?: SqlValue[]): Promise<T[]>;
  transaction<T>(cb: (tx: SqlTx) => Promise<T>): Promise<T>;
  onRemoteChange(cb: (c: RemoteChange) => void): () => void;
  onStateChange(cb: (s: DbState) => void): () => void;
  readonly state: DbState;
  whenLive(): Promise<void>;
  rebaseFromServer(): Promise<void>;
  close(): Promise<void>;
}

/** The synced-SQLite API surface (`app.plugins.plugins["realtime"].sql`). */
export interface RealtimeSql {
  /**
   * Resolves once Realtime is enabled, signed in, and bound to a vault.
   * Never resolves while the user stays signed out — pass an `AbortSignal`
   * to stop waiting early.
   */
  whenAvailable(opts?: { signal?: AbortSignal }): Promise<void>;
  open(opts: OpenOptions): Promise<DatabaseHandle>;
  /** Soft-delete: tombstone the doc AND drop it into the vault trash bin. */
  delete(opts: DeleteOrRestoreOptions): Promise<void>;
  /** Clear the tombstone so a fresh open() re-bootstraps. */
  restore(opts: DeleteOrRestoreOptions): Promise<void>;
  /** True when a non-tombstoned database with this id currently exists. */
  isLive(opts: DeleteOrRestoreOptions): Promise<boolean>;
  /** Escape hatch: rebuild every currently-open database from the server replica. */
  rebaseAll(): Promise<number>;
}
