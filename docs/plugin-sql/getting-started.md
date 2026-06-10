# Getting started

[← Back to index](./README.md)

## 1. Detect the Realtime plugin

The API is exposed on the Realtime plugin instance as `sql`. Realtime may be
disabled, not installed, or signed out, so always detect it defensively.

```ts
import type { Plugin } from "obsidian";

interface RealtimeApi {
  sql: RealtimeSql;
}

function getRealtime(plugin: Plugin): RealtimeApi | undefined {
  return (plugin.app as any).plugins?.plugins?.["realtime"] as RealtimeApi | undefined;
}
```

`RealtimeSql` and the other types below are documented in the
[API reference](./api-reference.md). You can copy the type definitions into your
plugin, or treat the handle loosely with `any` if you prefer.

## 2. Wait until Realtime is available

`whenAvailable()` resolves once Realtime is **enabled, signed in, and bound to a
vault**. Calling it lets you open databases from `onload()` without ordering
hacks.

```ts
async onload() {
  const realtime = getRealtime(this);
  if (!realtime) {
    console.warn("Realtime is not installed; my-plugin sync is disabled.");
    return;
  }
  await realtime.sql.whenAvailable();
  await this.openDatabase(realtime);
}
```

If you would rather not block, you can call `open()` directly and handle the
rejection (see step 4).

## 3. Open a database and define your schema

`open()` returns a database handle. The `migrate` callback runs **before sync
connects**; it is where you create tables and turn them into conflict-free
replicated relations (CRRs) with `crsql_as_crr`.

```ts
async openDatabase(realtime: RealtimeApi) {
  const db = await realtime.sql.open({
    pluginId: this.manifest.id,   // [A-Za-z0-9_-]{1,80}
    name: "tasks",                 // [A-Za-z0-9_-]{1,80}
    schemaVersion: 1,
    migrate: async (tx, fromVersion) => {
      if (fromVersion < 1) {
        await tx.exec(`
          CREATE TABLE tasks (
            id    TEXT PRIMARY KEY NOT NULL,
            title TEXT,
            done  INTEGER DEFAULT 0,
            created_at INTEGER
          )
        `);
        await tx.exec(`SELECT crsql_as_crr('tasks')`);
      }
    },
  });

  this.db = db;
}
```

> Primary keys must be supplied by you (UUID/ULID) — auto-increment ids collide
> across devices. See [Schema & CRR rules](./schema-and-crr.md).

## 4. Read, write, and react to remote changes

```ts
// Write (local writes do NOT fire onRemoteChange).
await db.exec(
  `INSERT INTO tasks (id, title, created_at) VALUES (?, ?, ?)`,
  [crypto.randomUUID(), "Buy milk", Date.now()],
);

// Query (typed).
interface Task { id: string; title: string; done: number; created_at: number }
const rows = await db.query<Task>(`SELECT * FROM tasks ORDER BY created_at`);

// React to changes merged from other devices.
const off = db.onRemoteChange(({ tables }) => {
  if (tables.includes("tasks")) this.refreshView();
});

// Later, when your view closes:
off();
```

## 5. Handle Realtime being disabled or signed out

`open()` rejects with a descriptive error when Realtime is disabled, signed out,
or has no active vault. Decide whether to degrade gracefully or surface a notice.

```ts
try {
  this.db = await realtime.sql.open({ /* … */ });
} catch (e) {
  // e.message is one of: "Realtime is disabled in settings.",
  // "Realtime is signed out — sign in first.", "Realtime has no active vault.", …
  new Notice(`Sync unavailable: ${(e as Error).message}`);
  // Fall back to a local-only mode, or simply disable the synced features.
}
```

## 6. Clean up on unload

Databases are reference-counted; call `close()` for each handle you open.

```ts
async onunload() {
  await this.db?.close();
}
```

Next: the full [API reference](./api-reference.md).
