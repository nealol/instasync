# Realtime Plugin SQL API

A synced, conflict-free **SQLite** database for third-party Obsidian plugins,
powered by [cr-sqlite](https://vlcn.io/) and the Realtime sync stack. Your plugin
gets a local SQL database that automatically replicates to every device in the
vault — offline-first, last-writer-wins per column, no servers to run.

```ts
const realtime = (this.app as any).plugins.plugins["realtime"];
await realtime.sql.whenAvailable();

const db = await realtime.sql.open({
  pluginId: this.manifest.id,
  name: "tasks",
  schemaVersion: 1,
  migrate: async (tx, fromVersion) => {
    await tx.exec(`CREATE TABLE tasks (id PRIMARY KEY NOT NULL, title, done)`);
    await tx.exec(`SELECT crsql_as_crr('tasks')`);
  },
});

await db.exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, [crypto.randomUUID(), "Hello"]);
const rows = await db.query(`SELECT * FROM tasks`);
db.onRemoteChange(({ tables }) => console.log("changed:", tables));
```

## When to use it

Use the Plugin SQL API when your plugin needs **structured, queryable, synced
state** that should converge across a user's devices (and collaborators):
task lists, kanban boards, reading queues, spaced-repetition decks, annotations,
custom indexes, etc.

It is *not* a replacement for storing notes — notes, canvases and attachments are
already synced by Realtime. Use SQL for the plugin's own auxiliary data.

## The model at a glance

```
your plugin
   │  open / exec / query / transaction
   ▼
in-memory cr-sqlite database  ──►  local snapshot (.obsidian/plugins/realtime/plugin-dbs/…)
   │  publishes change batches
   ▼
per-DB Y.Doc (native Yjs websocket)  ◄──►  other devices / collaborators
   │
   ▼
server replica + git dump (.realtime/plugin-dbs/…)  +  bootstrap endpoint
```

- **In-memory + snapshot.** The database lives in WASM memory for speed and is
  persisted to a local snapshot file (which preserves cr-sqlite's internal site
  ids and clocks, so deletes never resurrect on restart).
- **Y-log replication.** Every local write is published as a batch of
  `crsql_changes` into a per-database Y.Doc. Peers merge those batches into their
  own database — last-writer-wins per column, causal-length for whole-row
  create/delete races. Nothing ever errors; everything converges.
- **Server replica.** The Realtime server mirrors the log into an on-disk replica
  (when the cr-sqlite extension is installed), serves a bootstrap endpoint for
  fresh/stale clients, writes a deterministic SQL dump into the vault's git
  history, and compacts the log once everyone has caught up. Devices that have
  not synced for 30 days no longer hold back compaction; when such a device
  returns, it re-bootstraps from the server replica instead of replaying the log.
- **Trash-bin deletion.** Deleting a database is a *soft delete* — it lands in the
  vault's trash bin and can be restored, or permanently purged.
- **Access from outside Obsidian.** The server replica also backs server-side
  SQL access over REST: `GET /api/vaults/{id}/plugin-dbs` lists the databases
  the server holds a replica for (filtered by the caller's path ACL),
  `POST …/{plugin}/{name}/query` runs a read-only `SELECT` (refreshed against
  the Y.Doc first), and `POST …/{plugin}/{name}/execute` runs
  `INSERT`/`UPDATE`/`DELETE`/`REPLACE` statements in one transaction and
  publishes the resulting changes as a server-authored batch so all devices
  converge (CRDT last-writer-wins, just like any peer's edit). If the batch
  commits to the replica but the publish to the Y.Doc transiently fails, the
  call still succeeds: the batch is queued in memory and retried by the next
  replication pass or server-authored write (a server restart drops the queue;
  the replica and git dump still retain the data). Schema changes are
  rejected — the schema is owned by plugin `migrate()` on clients — and SQL
  referencing `crsql_*`/`sqlite_*` identifiers is rejected (string literals
  mentioning them are fine; the lint is token-aware). The same surfaces are
  exposed as MCP tools (`list_plugin_databases`, `query_plugin_database`, and
  `write_plugin_database`, which accepts multiple statements in one
  transaction) and through the TypeScript SDK (`VaultHandle.listPluginDbs()`,
  `PluginDbResource.query()`, `PluginDbResource.execute()`). All of these
  require the cr-sqlite loadable extension on the server
  (`config.crsqlite_ext_path`); without it they return a clear error.

## Limits

There is currently **no storage quota** on plugin databases: the snapshot, Y-log,
server replica, and git dumps all grow with your data. Be a good citizen — keep
databases lean (the whole DB lives in memory on every device), prune rows your
plugin no longer needs, and prefer one database per concern over one giant one.
Server-side quota enforcement is on the roadmap.

## Contents

- [Getting started](./getting-started.md) — detection, a minimal end-to-end example, handling signed-out state.
- [API reference](./api-reference.md) — every type and method, validation rules, the lint.
- [Schema & CRR rules](./schema-and-crr.md) — the constraints cr-sqlite imposes on your tables.
- [Conflict resolution](./conflict-resolution.md) — merge semantics, the counter anti-pattern, `onMergeReview`.
- [Migrations](./migrations.md) — the additive-only schema-version contract and `needs-migration`.
- [Lifecycle & deletion](./lifecycle-and-deletion.md) — open/close/refcount, snapshots, trash, the rebase escape hatch.
- [Troubleshooting](./troubleshooting.md) — common errors and recovery.
