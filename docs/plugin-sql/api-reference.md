# API reference

[← Back to index](./README.md)

The API is reached via `app.plugins.plugins["realtime"].sql`.

```ts
interface RealtimeSql {
  open(opts: OpenOptions): Promise<DatabaseHandle>;
  delete(opts: { pluginId: string; name: string }): Promise<void>;
  restore(opts: { pluginId: string; name: string }): Promise<void>;
  isLive(opts: { pluginId: string; name: string }): Promise<boolean>;
  whenAvailable(): Promise<void>;
}
```

## `sql.open(options)`

Open (or attach to an already-open) database and start syncing it. Resolves once
the engine is connected and has caught up; awaits layout-ready internally, so it
is safe to call in `onload()`.

```ts
interface OpenOptions {
  pluginId: string;       // your manifest id, [A-Za-z0-9_-]{1,80}
  name: string;           // database name,    [A-Za-z0-9_-]{1,80}
  schemaVersion: number;  // positive integer; bump on additive schema changes
  migrate: (tx: SqlTx, fromVersion: number) => Promise<void>;
  onMergeReview?: (tables: string[]) => void | Promise<void>;
}
```

- **`pluginId` / `name`** must match `^[A-Za-z0-9_-]{1,80}$` and must not
  contain `__` (a double underscore is the internal doc-id separator). Invalid
  ids reject.
  The pair identifies the database; opening the same pair twice returns a shared,
  reference-counted handle.
- **`schemaVersion`** is stored in the snapshot and the per-DB doc. Bump it when
  you change the schema (see [Migrations](./migrations.md)).
- **`migrate(tx, fromVersion)`** runs before sync connects. `fromVersion` is `0`
  for a brand-new database, or the snapshot's stored version on upgrade. Create
  tables and call `crsql_as_crr` here. When *altering* an existing CRR, wrap the
  change in `crsql_begin_alter('t')` / `crsql_commit_alter('t')`.
- **`onMergeReview(tables)`** (optional) runs after each batch of remote changes
  is applied — a hook for repair queries (e.g. de-duplicating by a logical key
  that cannot be a SQL `UNIQUE`). See [Conflict resolution](./conflict-resolution.md).

Rejects with a descriptive `Error` if Realtime is disabled, signed out, has no
active vault, or if the ids are invalid.

### Returns: `DatabaseHandle`

```ts
interface DatabaseHandle {
  exec(sql: string, bind?: SqlValue[]): Promise<void>;
  query<T = Record<string, SqlValue>>(sql: string, bind?: SqlValue[]): Promise<T[]>;
  transaction<T>(cb: (tx: SqlTx) => Promise<T>): Promise<T>;
  onRemoteChange(cb: (change: { tables: string[] }) => void): () => void;
  onStateChange(cb: (state: DbState) => void): () => void;
  readonly state: DbState;
  whenLive(): Promise<void>;
  rebaseFromServer(): Promise<void>;
  close(): Promise<void>;
}

type SqlValue = null | number | bigint | string | Uint8Array | boolean;
```

#### `exec(sql, bind?)`

Run a statement that does not return rows. Schedules a debounced publish +
snapshot. Throws if the SQL touches `crsql_*` / `sqlite_*` internals (see the
[lint](#the-crsql_--sqlite_-lint) below).

#### `query<T>(sql, bind?)`

Run a query and return an array of row objects (`{ col: value, … }`).

#### `transaction(cb)`

Run multiple statements atomically. The callback receives a `SqlTx`:

```ts
interface SqlTx {
  exec(sql: string, bind?: SqlValue[]): Promise<void>;
  query<T>(sql: string, bind?: SqlValue[]): Promise<T[]>;
}

await db.transaction(async (tx) => {
  await tx.exec(`UPDATE tasks SET done = 1 WHERE id = ?`, [id]);
  const [{ n }] = await tx.query<{ n: number }>(`SELECT count(*) n FROM tasks WHERE done = 1`);
  return n;
});
```

A single change batch is published per transaction.

#### `onRemoteChange(cb)`

Subscribe to changes merged **from other devices**. Fires once per applied batch
group with the distinct affected table names. **Local writes do not fire it.**
Returns an unsubscribe function.

#### `onStateChange(cb)` and `state`

Observe the engine lifecycle. `state` is one of:

| State | Meaning |
| --- | --- |
| `loading-wasm` | The cr-sqlite WASM runtime is loading. |
| `restoring` | Rebuilding from the local snapshot. |
| `bootstrapping` | Pulling the full changeset from the server replica. |
| `syncing` | Connected; catching up on the batch log. |
| `live` | Caught up and replicating in real time. |
| `offline` | Closed / disconnected. |
| `needs-migration` | A peer is on a newer `schemaVersion`; update your plugin. See [Migrations](./migrations.md). |
| `error` | A terminal error (e.g. the database was deleted, or WASM failed to load). |

#### `whenLive()`

Resolves when `state` becomes `live`; rejects if the database enters `error`.

#### `rebaseFromServer()`

Escape hatch: discard the local database + snapshot and rebuild from the server
replica. Use it to recover from suspected divergence/corruption. Also available
as the command-palette action **"Realtime: Rebase plugin databases from server"**.

#### `close()`

Decrement the handle's refcount; the shared engine closes (flushing a final
snapshot) when the last handle closes.

## `sql.delete({ pluginId, name })`

**Soft delete.** Tombstones the database and drops it into the vault **trash
bin**, where it appears as a "Database" entry. The data is retained and can be
restored. See [Lifecycle & deletion](./lifecycle-and-deletion.md).

## `sql.restore({ pluginId, name })`

Clear the tombstone so a fresh `open()` re-bootstraps. This is also what the
trash bin's **Restore** button calls. Restore is rejected by the trash UI if a
live database with the same id already exists.

## `sql.isLive({ pluginId, name })`

Resolves `true` when a non-tombstoned database with this id currently exists.

## `sql.whenAvailable(opts?)`

```ts
whenAvailable(opts?: { signal?: AbortSignal }): Promise<void>
```

Resolves once Realtime is enabled, signed in, and bound to a vault. It never
resolves while the user stays signed out, so pass an `AbortSignal` if you need
to stop waiting (the promise rejects on abort, and Realtime's own unload also
rejects all pending waiters):

```ts
const ctrl = new AbortController();
this.register(() => ctrl.abort()); // stop waiting when *your* plugin unloads
await realtime.sql.whenAvailable({ signal: ctrl.signal });
```

## The `crsql_*` / `sqlite_*` lint

`exec` and `query` (and their `tx` equivalents) reject SQL that references
`crsql_*` or `sqlite_*` internals — those are reserved for the engine and for
your `migrate` callback. Define schema (including `crsql_as_crr`) inside
`migrate`, where the lint does not apply.

```ts
// Rejected outside migrate:
await db.exec(`SELECT crsql_as_crr('tasks')`);
// Do this inside migrate(tx, …) instead.
```

The lint is a plain substring check on the SQL text, so it also rejects
statements whose *string literals* happen to contain `crsql_` or `sqlite_`
(for example `INSERT INTO notes (body) VALUES ('about sqlite_master')`).
Pass such values as **bound parameters** (`?`) instead of inlining them — which
is the right thing to do anyway.
