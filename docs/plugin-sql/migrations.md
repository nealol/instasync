# Migrations

[← Back to index](./README.md)

Plugin databases sync across devices that may be running **different versions of
your plugin** at the same time. The schema-version contract keeps those devices
from corrupting each other.

## The contract: additive only

> **Never drop or repurpose a column. Only add.**

Because changes replicate at the column level, an older client must be able to
apply a newer client's changes by simply ignoring columns it doesn't know about,
and a newer client must be able to apply an older client's changes by leaving its
extra columns at their defaults. That only works if the schema grows
monotonically:

- Allowed: add a new table.
- Allowed: add a new (nullable / defaulted) column to an existing CRR.
- Not allowed: drop a column.
- Not allowed: rename a column (that's a drop + add — old data is stranded).
- Not allowed: change the meaning/units of an existing column.

If you must change a column's meaning, add a *new* column and migrate reads to
prefer it.

## `schemaVersion` and `migrate`

Each `open()` declares a `schemaVersion` (a positive integer) and a `migrate`
callback. `migrate(tx, fromVersion)` runs before sync connects, with
`fromVersion` = the version the local snapshot was last at (`0` for a fresh
database). Gate each step on `fromVersion` so upgrades apply incrementally:

```ts
const db = await realtime.sql.open({
  pluginId: this.manifest.id,
  name: "tasks",
  schemaVersion: 3,
  migrate: async (tx, fromVersion) => {
    if (fromVersion < 1) {
      await tx.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY NOT NULL, title)`);
      await tx.exec(`SELECT crsql_as_crr('tasks')`);
    }
    if (fromVersion < 2) {
      await tx.exec(`SELECT crsql_begin_alter('tasks')`);
      await tx.exec(`ALTER TABLE tasks ADD COLUMN done INTEGER DEFAULT 0`);
      await tx.exec(`SELECT crsql_commit_alter('tasks')`);
    }
    if (fromVersion < 3) {
      await tx.exec(`SELECT crsql_begin_alter('tasks')`);
      await tx.exec(`ALTER TABLE tasks ADD COLUMN due INTEGER`);
      await tx.exec(`SELECT crsql_commit_alter('tasks')`);
    }
  },
});
```

The new `schemaVersion` is stored in the snapshot and published into the per-DB
doc.

## How version-tagged batches behave across versions

Every change batch carries the producing client's `schemaVersion`:

- **Older batch (version < yours):** applied normally. Columns your schema added
  later are simply absent; cr-sqlite leaves them at their defaults.
- **Newer batch (version > yours):** **buffered, not applied.** Your client must
  not apply changes that reference columns it doesn't have yet. The handle's
  `state` becomes `needs-migration`.

## The `needs-migration` state

When a peer is on a newer `schemaVersion` than you, the engine surfaces
`state: "needs-migration"` and holds the newer batches. This means: **the user
should update your plugin.** Once they do (and reopen at the higher
`schemaVersion`), the buffered batches apply.

```ts
db.onStateChange((state) => {
  if (state === "needs-migration") {
    new Notice("A collaborator is using a newer version of My Plugin. Please update to sync.");
  }
});
```

You cannot "fix" `needs-migration` from the older client — it is a signal to ship
and install a plugin update whose `schemaVersion` is at least as high as the
incoming batches.
