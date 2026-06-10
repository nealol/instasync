# Schema & CRR rules

[← Back to index](./README.md)

A synced table must be a **conflict-free replicated relation (CRR)**. You turn a
normal table into a CRR inside `migrate` with `crsql_as_crr('table_name')`.
cr-sqlite imposes constraints that you MUST follow — they are checked when you
call `crsql_as_crr`, and violating them makes a table unsyncable.

## The rules

1. **A primary key is required.** Every CRR needs an explicit `PRIMARY KEY`.
   ```sql
   CREATE TABLE tasks (id TEXT PRIMARY KEY NOT NULL, title, done);
   ```

2. **Use client-generated primary keys — never auto-increment.** Two devices
   inserting offline would both pick the same rowid and collide. Generate a
   UUID or ULID in your plugin:
   ```ts
   await db.exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, [crypto.randomUUID(), title]);
   ```
   `AUTOINCREMENT` / `INTEGER PRIMARY KEY` rowid tables are not safe for sync.

3. **Non-primary-key columns must be nullable or have a default.** A merge may
   create a row from a single column's change before other columns arrive, so
   every non-pk column must tolerate being absent:
   ```sql
   CREATE TABLE tasks (
     id    TEXT PRIMARY KEY NOT NULL,
     title TEXT,                    -- nullable
     done  INTEGER DEFAULT 0,       -- defaulted
     created_at INTEGER             -- nullable
   );
   ```
   `NOT NULL` is only allowed on the primary key (or with a `DEFAULT`).

4. **No extra `UNIQUE` indexes besides the primary key.** cr-sqlite cannot
   enforce a second uniqueness constraint across independently-merging replicas.
   Model "uniqueness" at the application level (see
   [Conflict resolution](./conflict-resolution.md) and `onMergeReview`).

5. **No checked foreign keys.** Don't rely on `FOREIGN KEY` enforcement; rows
   from different tables arrive independently. Keep referential integrity in your
   query/application logic.

## Calling `crsql_as_crr`

Always create the table first, then promote it, inside `migrate`:

```ts
migrate: async (tx, fromVersion) => {
  if (fromVersion < 1) {
    await tx.exec(`
      CREATE TABLE cards (
        id TEXT PRIMARY KEY NOT NULL,
        deck TEXT,
        front TEXT,
        back TEXT,
        ease REAL DEFAULT 2.5,
        due INTEGER
      )
    `);
    await tx.exec(`SELECT crsql_as_crr('cards')`);
  }
}
```

## Altering a CRR later

When you change an existing CRR's schema in a later migration, wrap the change in
`crsql_begin_alter` / `crsql_commit_alter` so cr-sqlite can rebuild its bookkeeping:

```ts
migrate: async (tx, fromVersion) => {
  if (fromVersion < 1) {
    await tx.exec(`CREATE TABLE cards (id TEXT PRIMARY KEY NOT NULL, front, back)`);
    await tx.exec(`SELECT crsql_as_crr('cards')`);
  }
  if (fromVersion < 2) {
    await tx.exec(`SELECT crsql_begin_alter('cards')`);
    await tx.exec(`ALTER TABLE cards ADD COLUMN ease REAL DEFAULT 2.5`);
    await tx.exec(`SELECT crsql_commit_alter('cards')`);
  }
}
```

Schema changes must be **additive only** — never drop or repurpose a column.
See [Migrations](./migrations.md) for the full contract.

## Data types

cr-sqlite stores standard SQLite types: `NULL`, `INTEGER`, `REAL`, `TEXT`,
`BLOB`. Bind values from JS as `null | number | bigint | string | Uint8Array |
boolean`. Booleans are stored as integers (`0`/`1`).
