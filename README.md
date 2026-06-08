# Realtime

Google-Docs-style collaborative editing for Obsidian, powered by [Yjs](https://github.com/yjs/yjs) and a [y-sweet](https://github.com/drifting-in-space/y-sweet) server.

For this prototype, **the whole vault is synced** — every Markdown file, plus binary attachments (images, PDFs, …) by default — rather than specific shared folders. You point the plugin at one server URL, and that server hosts one vault. (Binary sync is toggleable in settings, with an exclude-glob list.)

## How it works

- **Vault index** — a single Yjs document (`vault id`) holds a map of `path → doc-guid` for Markdown files **and** a `path → { hash, size }` map for binary files. This is how file creation/deletion/rename propagates between clients.
- **Per-file documents** — each Markdown file is its own Yjs document (a `Y.Text` named `contents`) hosted on the y-sweet server, keyed by a stable guid.
- **Binary files** — synced by content hash, not through the text CRDT (`src/BinarySync.ts`): the bytes go to a content-addressed blob store on the server (`BLOB_DIR/{vaultId}/{hash}`) and only the hash travels through the index. Concurrent edits to the same binary can't be merged, so they're resolved by a keep-local / keep-remote modal on the device that detects the divergence. Large files upload in the background, deferred while notes are actively syncing.
- **Remote Cursors / MCP** — vault admins can create app-specific remote cursors. Each cursor has an MCP resource URL (`/mcp/i/{appId}`) and supports OAuth 2.1 for MCP clients, while direct REST automation can still use the generated cursor secret as a bearer token.
- **Editor binding** — when a file is open, a CodeMirror 6 view plugin (`src/editor/LiveEdit.ts`) binds the editor to the shared text in both directions. When a file is *not* open, `src/Document.ts` keeps the file on disk in sync with the shared text.
- **Live cursors** — `src/editor/RemoteSelections.ts` renders each collaborator's caret and selection, labelled with a generated **two-word name** (e.g. "Brave Otter") and a color, broadcast over Yjs awareness.

## Running a server

The Docker image is **self-contained**: it runs y-sweet internally and
reverse-proxies its sync traffic under `/d/*`, so you expose **one port** and the
plugin only ever needs **one URL** (`PUBLIC_BASE_URL`). No separate y-sweet
process or second URL to manage.

```
                          ┌──────── realtime-server container ────────┐
Obsidian ──HTTPS/WSS──▶   │ auth + /d/* proxy ──▶ y-sweet (127.0.0.1)   │
                          │ SQLite + y-sweet store on the /data volume  │
                          └─────────────────────────────────────────────┘
```

### 1. Generate a shared auth key

The image bundles a correctly-built y-sweet binary, so generate the key straight
from it (this avoids the broken Windows `npx y-sweet` launcher):

```bash
docker run --rm --entrypoint y-sweet ghcr.io/nealol/realtime-server:latest gen-auth --json
# prints { "private_key": "...", ... } — copy the private_key value
```

### 2. Start the server

```bash
docker run -d \
  --name realtime-server \
  -p 8081:8081 \
  -v realtime-data:/data \
  -e OIDC_MODE=oidc \
  -e OIDC_ISSUER=https://id.example.com \       # your PocketID base URL (no trailing slash)
  -e OIDC_CLIENT_ID=<uuid from PocketID> \
  -e OIDC_CLIENT_SECRET=<secret shown once> \
  -e PUBLIC_BASE_URL=https://sync.example.com \ # how clients reach this server (baked into tokens)
  -e YSWEET_AUTH_KEY=<private_key from step 1> \
  ghcr.io/nealol/realtime-server:latest
```

Put a TLS-terminating reverse proxy (Caddy, nginx, Traefik, …) in front and point
it at port `8081`; it must forward **WebSocket upgrades** on `/d/*`. Set
`PUBLIC_BASE_URL` to that public HTTPS URL — it is baked into the client tokens
y-sweet mints (`wss://sync.example.com/d/{doc}/ws`), and it is the only URL you
enter in the plugin.

The SQLite database **and** the y-sweet document store both live under the
`/data` volume and persist across restarts.

#### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `OIDC_MODE` | `oidc` | `oidc` for a real IdP; `mock` for local dev/testing |
| `OIDC_ISSUER` | — | Your PocketID base URL (no trailing slash) |
| `OIDC_CLIENT_ID` | — | UUID from PocketID |
| `OIDC_CLIENT_SECRET` | — | Secret shown once in PocketID |
| `OIDC_REDIRECT_URL` | `${PUBLIC_BASE_URL}/auth/callback` | Override only if you need a custom callback URL — must match the PocketID callback URL exactly |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:8081` | How clients reach this server; baked into minted sync tokens |
| `YSWEET_AUTH_KEY` | — | Shared private key from step 1 (used by both the internal y-sweet and the auth server) |
| `BIND_ADDR` | `0.0.0.0:8081` | Listen address inside the container |
| `DATABASE_URL` | `sqlite:///data/realtime.db?mode=rwc` | SeaORM SQLite URL |
| `UPLOAD_TOKEN` | `dev-upload-token-change-me` | HMAC key for signed single-use browser upload links; set a long random secret in production |
| `ATTACHMENT_ALLOWED_EXTENSIONS` | common images, `pdf`, `txt` | Comma-separated allowed attachment extensions, without or with leading dots |
| `ATTACHMENT_MAX_BYTES` | raw blob max | Per-attachment upload/fetch size cap; separate from the raw content-addressed blob store cap |
| `ATTACHMENTS_PATH_MODE` | `relative` | `relative` allows any valid vault-relative attachment path; `subfolder` requires paths under `ATTACHMENTS_SUBFOLDER` |
| `ATTACHMENTS_SUBFOLDER` | — | Required when `ATTACHMENTS_PATH_MODE=subfolder`; also used as the default signed-upload landing directory |
| `ATTACHMENT_FETCH_HOST_ALLOWLIST` | — | Comma-separated hostnames allowed for server-side attachment fetches from URL |
| `CURSOR_EMAIL_DOMAIN` | domain from `GIT_BOT_EMAIL`, else `localhost` | Domain for synthetic cursor authors in git audit commits |
| `DAILY_NOTE_PATH_TEMPLATE` | `Daily Notes/{{YYYY-MM-DD}}.md` | Daily periodic note path template |
| `WEEKLY_NOTE_PATH_TEMPLATE` / `MONTHLY_NOTE_PATH_TEMPLATE` / `QUARTERLY_NOTE_PATH_TEMPLATE` / `YEARLY_NOTE_PATH_TEMPLATE` | — | Optional periodic note templates |

The internal y-sweet is wired up automatically (`YSWEET_INTERNAL_PORT`, default
`8080`; `YSWEET_STORE`, default `/data/ysweet`) — override these only for advanced
setups. To run y-sweet as a separate external process instead, see
[`server/README.md`](server/README.md).

Swagger UI is available at `/docs`, and the generated OpenAPI document is served
at `/openapi.json`. The spec covers REST, auth, OAuth, signed upload, and
permalink endpoints; it intentionally excludes `/mcp`, `/d/*`, raw blob storage,
and `/api/doc-token`.

## Plugin setup

1. Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat): add `nealol/realtime` as a beta plugin, or build manually:
   ```bash
   npm install
   npm run build
   ```
   Then copy `main.js`, `manifest.json`, and `styles.css` into
   `<your-vault>/.obsidian/plugins/realtime/`.
2. Enable **Realtime** in Obsidian's *Community plugins* settings.
3. Open **Settings → Realtime**, set the **Auth server URL** (e.g. `https://auth.example.com`), and sign in.
4. Create or join a vault from the Realtime settings. All collaborators must join the same vault.
5. Each client gets a random two-word cursor name; reroll it with the dice button.

The status bar shows `Realtime: connecting… / live / error`.

## Synced Plugin Databases

Third-party Obsidian plugins can open low-level cr-sqlite databases through the Realtime plugin API. Tables that should sync must be converted to cr-sqlite CRRs by the caller; Realtime transports `crsql_changes` rows through a Y-Sweet document instead of syncing `.sqlite` files as binary attachments.

```ts
const realtime = app.plugins.plugins.realtime;

const db = await realtime.openSyncedDatabase({
	pluginId: "my-plugin",
	name: "main",
	schema: async (db) => {
		await db.exec(`
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY NOT NULL,
				title TEXT,
				done INTEGER
			);
			SELECT crsql_as_crr('tasks');
		`);
	},
});

await db.exec("INSERT INTO tasks(id, title, done) VALUES (?, ?, ?)", ["t1", "Ship", 0]);
```

`pluginId` and `name` may contain only ASCII letters, numbers, dash, and underscore. API calls wait for Realtime startup, then require Realtime sync to be enabled, signed in, bound to a vault, and running.

Close a handle when your plugin unloads:

```ts
async onunload() {
	await this.db?.close();
	this.db = null;
}
```

To delete the entire synced database for your plugin, call `deleteSyncedDatabase` with the same `pluginId` and `name`:

```ts
await realtime.deleteSyncedDatabase({
	pluginId: "my-plugin",
	name: "main",
});
```

Deletion closes any open local handle, removes the local checkpoint, clears the synced Yjs database state, unregisters the server-side plugin DB pseudo-file, and writes a backend tombstone so other clients do not resurrect old batches. Y-Sweet does not currently expose physical document deletion, so the backend document is cleared/tombstoned rather than removed from storage.

## Development

```bash
npm run dev        # esbuild watch -> main.js
npm run typecheck  # tsc -noEmit
```

## Caveats (prototype)

- First-write seeding: when a file is first shared, the client that registers it
  seeds the shared doc from disk; other clients treat the shared doc as
  authoritative and overwrite their local copy. There is no three-way merge.
- Conflict handling beyond CRDT text merging (e.g. simultaneous first-time
  sharing of differing files) is intentionally minimal.
