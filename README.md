# Realtime

Google-Docs-style collaborative editing for Obsidian, powered by [Yjs](https://github.com/yjs/yjs) and a [y-sweet](https://github.com/drifting-in-space/y-sweet) server.

For this prototype, **the whole vault is synced** — every Markdown file, plus binary attachments (images, PDFs, …) by default — rather than specific shared folders. You point the plugin at one server URL, and that server hosts one vault. (Binary sync is toggleable in settings, with an exclude-glob list.)

## How it works

- **Vault index** — a single Yjs document (`vault id`) holds a map of `path → doc-guid` for Markdown files **and** a `path → { hash, size }` map for binary files. This is how file creation/deletion/rename propagates between clients.
- **Per-file documents** — each Markdown file is its own Yjs document (a `Y.Text` named `contents`) hosted on the y-sweet server, keyed by a stable guid.
- **Binary files** — synced by content hash, not through the text CRDT (`src/BinarySync.ts`): the bytes go to a content-addressed blob store on the server (`BLOB_DIR/{vaultId}/{hash}`) and only the hash travels through the index. Concurrent edits to the same binary can't be merged, so they're resolved by a keep-local / keep-remote modal on the device that detects the divergence. Large files upload in the background, deferred while notes are actively syncing.
- **Remote Cursors / MCP** — vault admins can create app-specific remote cursors. Each cursor has an MCP resource URL (`/mcp/i/{appId}`) and supports OAuth 2.1 for MCP clients, while direct REST automation can still use the generated cursor secret as a bearer token.
- **Public sharing** — file-menu actions copy revocable public links for Markdown notes and binary attachments. Attachment links expose only the exact file version that was shared and stop resolving if the attachment changes or the link is revoked.
- **Editor binding** — when a file is open, a CodeMirror 6 view plugin (`src/editor/LiveEdit.ts`) binds the editor to the shared text in both directions. When a file is *not* open, `src/Document.ts` keeps the file on disk in sync with the shared text.
- **Live cursors** — `src/editor/RemoteSelections.ts` renders each collaborator's caret and selection, labelled with a generated **two-word name** (e.g. "Brave Otter") and a color, broadcast over Yjs awareness.
- **Realtime Canvas** — node moves, resizes, text, styles, edges, and ordering sync as field-level operations. Drag previews, selections, collaborator labels, and viewport follow use awareness, so they never alter the `.canvas` file. Text cards use `Y.Text` when Obsidian exposes a compatible CodeMirror editor; changed private APIs fall back to snapshot or disk sync.

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
| `ATTACHMENT_ALLOWED_EXTENSIONS` | common images, `pdf`, `txt` | Comma-separated extensions allowed for signed and server-fetched uploads; `*` allows every extension and extensionless files |
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
   bun install
   bun run build
   ```
   Then copy `main.js`, `manifest.json`, and `styles.css` into
   `<your-vault>/.obsidian/plugins/realtime/`.
2. Enable **Realtime** in Obsidian's *Community plugins* settings.
3. Open **Settings → Realtime**, set the **Auth server URL** (e.g. `https://auth.example.com`), and sign in.
4. Create or join a vault from the Realtime settings. All collaborators must join the same vault.
5. Each client gets a random two-word cursor name; reroll it with the dice button.

The status bar shows `Realtime: connecting… / live / error`.

The plugin and server versions plus the active vault ID are under
**Settings → Realtime → Technical details** at the bottom of the page.

### Working together in Canvas

Open the same `.canvas` file on two joined devices. Durable edits sync during a drag instead of waiting for Obsidian's delayed save, while remote selections and drag outlines appear without writing transient data into the file. Click a collaborator label to follow their pan and zoom; any local pan, zoom, file change, or collaborator departure stops follow mode.

If the plugin can't use the installed Obsidian version's private Canvas methods, editing still works through full Canvas imports or disk write-through. A small loading notice appears when a Canvas references a synced binary that hasn't arrived yet. Markdown links in file nodes don't enter binary sync.

## CLI

The [`rtmd` CLI](packages/cli/README.md) can bind a local folder to a vault and
run explicit pull/push syncs. Attachment sync is configured per bound folder:

```sh
rtmd config attachments off
rtmd config attachments on --include "assets/**,**/*.pdf"
rtmd config attachments on --all
```

Non-matching attachments are ignored locally and remotely. Run `rtmd whoami`
to see the bound vault ID.

## Plugin SQL API for developers

Realtime exposes a synced, conflict-free **SQLite** database to other Obsidian
plugins via `app.plugins.plugins["realtime"].sql`. Your plugin gets a local
cr-sqlite database that replicates to every device in the vault — offline-first,
last-writer-wins per column, with snapshots, a server-side replica, deterministic
git dumps, and trash-bin deletion. See the full guide:
**[docs/plugin-sql/](docs/plugin-sql/README.md)**.

## Compatibility & versioning

The plugin and server release on independent cadences. Compatibility is gated
by **named capability versions** advertised on `GET /api/server-info`, not by
either side's semver. The plugin hard-blocks on a cap mismatch and never
nudges about newer server versions unless compatibility is actually broken.
See **[docs/versioning.md](docs/versioning.md)** for the cap names, bump
rules, gating behavior, and rollout notes.

```ts
const realtime = (this.app as any).plugins.plugins["realtime"];
await realtime.sql.whenAvailable();
const db = await realtime.sql.open({
  pluginId: this.manifest.id,
  name: "tasks",
  schemaVersion: 1,
  migrate: async (tx, fromVersion) => {
    if (fromVersion < 1) {
      await tx.exec(`CREATE TABLE tasks (id PRIMARY KEY NOT NULL, title, done)`);
      await tx.exec(`SELECT crsql_as_crr('tasks')`);
    }
  },
});
await db.exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, [crypto.randomUUID(), "Hi"]);
```

## Development

```bash
bun install        # install dependencies
bun run dev        # esbuild watch -> main.js
bun run typecheck  # tsc -noEmit
bun run test       # vitest (plugin + sdk unit tests)
bun run test:all   # typecheck + all unit tests + Rust server tests
```

## Caveats (prototype)

- First-write seeding: when a file is first shared, the client that registers it
  seeds the shared doc from disk; other clients treat the shared doc as
  authoritative and overwrite their local copy. There is no three-way merge.
- Conflict handling beyond CRDT text merging (e.g. simultaneous first-time
  sharing of differing files) is intentionally minimal.
