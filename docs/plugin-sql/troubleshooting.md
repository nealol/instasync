# Troubleshooting

[← Back to index](./README.md)

## `open()` rejects immediately

The message tells you why:

| Message | Cause | Fix |
| --- | --- | --- |
| `Realtime is disabled in settings.` | The Realtime plugin is toggled off. | Ask the user to enable Realtime, or degrade gracefully. |
| `Realtime is signed out — sign in first.` | No active session. | Wait on `sql.whenAvailable()` or prompt the user to sign in. |
| `Realtime has no active vault.` | Signed in but no vault bound. | Prompt the user to set up a vault in Realtime settings. |
| `pluginId must match [A-Za-z0-9_-]{1,80}` / `name must match …` | Invalid id. | Use only letters, digits, `-`, `_`, 1–80 chars, and no `__` (double underscore). |
| `schemaVersion must be a positive integer.` | Bad `schemaVersion`. | Pass `1`, `2`, … |

Guard with `whenAvailable()` and a `try/catch`:

```ts
const realtime = (this.app as any).plugins.plugins["realtime"];
if (!realtime) return; // not installed
await realtime.sql.whenAvailable();
try {
  this.db = await realtime.sql.open({ /* … */ });
} catch (e) {
  new Notice(`Sync unavailable: ${(e as Error).message}`);
}
```

## WASM fails to load (`state: "error"`, reason `wasm`)

The cr-sqlite WASM runtime could not be loaded.

- The plugin ships `crsqlite.wasm` and caches it under the plugin directory. If it
  is missing, the engine downloads it once (matching the plugin version) via
  Obsidian's `requestUrl` and caches it through the vault adapter (works on
  mobile).
- The runtime is handed a **same-origin blob URL** — never a cross-origin URL —
  to avoid CORS on the Emscripten fetch. If you fork the plugin, keep that
  behavior.
- If the download host is unreachable and no cached copy exists, loading fails.
  Ship `crsqlite.wasm` alongside `main.js`.

## "exec/query may not touch crsql_* or sqlite_* internals"

The [lint](./api-reference.md#the-crsql_--sqlite_-lint) blocks `crsql_*` /
`sqlite_*` references in `exec`/`query`. Move schema work (including
`crsql_as_crr`, `crsql_begin_alter`, `crsql_commit_alter`) into the `migrate`
callback, where the lint does not apply.

## A collaborator's changes aren't applying (`state: "needs-migration"`)

A peer is on a newer `schemaVersion`. Your client buffers their batches until your
plugin is updated to at least that version. Ship an update; see
[Migrations](./migrations.md).

## Increments / tallies come out wrong

You're hitting the LWW counter anti-pattern (`x = x + 1` clobbers concurrent
writes). Switch to the operation-log + aggregate pattern in
[Conflict resolution](./conflict-resolution.md).

## Suspected corruption or divergence

Rebuild from the server replica:

```ts
await db.rebaseFromServer();
```

or run the command palette action **"Realtime: Rebase plugin databases from
server"**. The engine also rebases automatically when a snapshot restore fails or
a needed range of the log was compacted away before this device caught up (a
"gap").

## Server-side replica / git dumps are missing

Server-side replication, the bootstrap endpoint's replica, and git dumps under
`.realtime/plugin-dbs/` require the cr-sqlite **loadable extension** on the
server (`CRSQLITE_EXT_PATH`). When it is absent, client-to-client sync over the Y
log still works, but the server keeps no replica and git skips the dumps. The
extension's major version must match the client WASM's sync-format major. See the
[server README](../../server/README.md).

## Deleted databases keep coming back, or won't restore

- A *soft delete* leaves the database in the trash bin; it reappears only if you
  call `restore()` (or use the trash UI). To remove it for good, **purge** it
  from the trash bin (permanent, irreversible).
- Restore is rejected if a *live* database with the same `(pluginId, name)`
  already exists — close/delete the live one first.
