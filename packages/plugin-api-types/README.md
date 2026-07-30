# @realtime-md/plugin-api-types

TypeScript type definitions for the [Realtime](https://github.com/nealol/realtime) Obsidian plugin's public API, exposed to other plugins as `app.plugins.plugins["realtime"]`.

Types only — no runtime code. The Realtime plugin itself `implements` these interfaces, so they cannot drift from the real API.

## Install

```sh
npm install --save-dev @realtime-md/plugin-api-types
```

## Use

```ts
import type { RealtimePluginApi } from "@realtime-md/plugin-api-types";

const realtime = this.app.plugins.plugins["realtime"] as
	| (Plugin & RealtimePluginApi)
	| undefined;
if (!realtime) return; // Realtime not installed/enabled

// Synced SQLite databases (see the docs/plugin-sql guide):
await realtime.sql.whenAvailable();
const db = await realtime.sql.open({
	pluginId: "my-plugin",
	name: "main",
	schemaVersion: 1,
	migrate: async (tx) => {
		await tx.exec("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, label TEXT)");
		await tx.exec("SELECT crsql_as_crr('items')");
	},
});

// Remote cursors (robot identities with audited, Git-attributed edits):
const cursor = await realtime.cursors.acquire({ pluginId: "my-plugin" });
await cursor.notes.append("Log.md", "- did a thing");

// Public URLs for a note and the current version of an attachment:
const noteUrl = await realtime.shares.getNoteUrl("Reports/July.md");
const attachmentUrl = await realtime.shares.getAttachmentUrl("assets/report.pdf");
```

## What's exported

- `RealtimePluginApi` — the root surface (`sql`, `cursors`, `shares`)
- SQL: `RealtimeSql`, `OpenOptions`, `DatabaseHandle`, `SqlTx`, `MigrateFn`, `DbState`, `SqlValue`, `RemoteChange`, …
- Cursors: `RealtimeCursors`, `RemoteCursorHandle`, `CursorNotesApi`, `CursorNote`, …
- Public sharing: `RealtimeShares`
- Replication wire format: `Batch`, `ChangeRow`, `Cursor`, `EncodedVal`

For driving the Realtime *server* (REST, OAuth, streaming) from outside Obsidian, see [`@realtime-md/sdk`](https://www.npmjs.com/package/@realtime-md/sdk).
