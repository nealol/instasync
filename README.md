# InstaSync

Google-Docs-style collaborative editing for Obsidian, powered by [Yjs](https://github.com/yjs/yjs) and a [y-sweet](https://github.com/drifting-in-space/y-sweet) server.

For this prototype, **every Markdown file in the vault is synced** (rather than specific shared folders). You point the plugin at one server URL, and that server hosts one vault.

## How it works

- **Vault index** — a single Yjs document (`vault id`) holds a map of `path → doc-guid`. This is how file creation/deletion/rename propagates between clients.
- **Per-file documents** — each Markdown file is its own Yjs document (a `Y.Text` named `contents`) hosted on the y-sweet server, keyed by a stable guid.
- **Editor binding** — when a file is open, a CodeMirror 6 view plugin (`src/editor/LiveEdit.ts`) binds the editor to the shared text in both directions. When a file is *not* open, `src/Document.ts` keeps the file on disk in sync with the shared text.
- **Live cursors** — `src/editor/RemoteSelections.ts` renders each collaborator's caret and selection, labelled with a generated **two-word name** (e.g. "Brave Otter") and a color, broadcast over Yjs awareness.

## Running a server

InstaSync requires two servers running side-by-side:

| Server | Role |
| --- | --- |
| **y-sweet** | CRDT sync (WebSocket) |
| **InstaSync auth server** | SSO login, vault management, mints y-sweet tokens |

### 1. Generate a shared auth key

```bash
npx y-sweet@latest gen-auth --json
# prints { "private_key": "...", ... } — copy the private_key value
```

### 2. Start y-sweet

```bash
npx y-sweet@latest serve --auth <private_key> --port 8080
```

### 3. Start the InstaSync auth server (Docker — recommended)

```bash
docker run -d \
  --name instasync-server \
  -p 8081:8081 \
  -v instasync-data:/data \
  -e OIDC_MODE=oidc \
  -e OIDC_ISSUER=https://id.example.com \       # your PocketID base URL (no trailing slash)
  -e OIDC_CLIENT_ID=<uuid from PocketID> \
  -e OIDC_CLIENT_SECRET=<secret shown once> \
  -e PUBLIC_BASE_URL=https://auth.example.com \ # how browsers reach this server
  -e YSWEET_AUTH_KEY=<same private_key> \
  -e YSWEET_URL=http://127.0.0.1:8080 \
  ghcr.io/nealol/instasync-server:latest
```

The SQLite database is stored in the `/data` volume and persists across restarts.

#### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `OIDC_MODE` | `oidc` | `oidc` for a real IdP; `mock` for local dev/testing |
| `OIDC_ISSUER` | — | Your PocketID base URL (no trailing slash) |
| `OIDC_CLIENT_ID` | — | UUID from PocketID |
| `OIDC_CLIENT_SECRET` | — | Secret shown once in PocketID |
| `OIDC_REDIRECT_URL` | `${PUBLIC_BASE_URL}/auth/callback` | Override only if you need a custom callback URL — must match the PocketID callback URL exactly |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:8081` | How browsers reach the auth server |
| `YSWEET_AUTH_KEY` | — | Shared private key (same value as `y-sweet serve --auth`) |
| `YSWEET_URL` | `http://127.0.0.1:8080` | Internal URL used to reach y-sweet |
| `YSWEET_PUBLIC_URL` | = `YSWEET_URL` | URL clients connect to (set this if y-sweet is on a different host) |
| `BIND_ADDR` | `0.0.0.0:8081` | Listen address inside the container |
| `DATABASE_URL` | `sqlite:///data/instasync.db?mode=rwc` | SeaORM SQLite URL |

## Plugin setup

1. Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat): add `nealol/instasync` as a beta plugin, or build manually:
   ```bash
   npm install
   npm run build
   ```
   Then copy `main.js`, `manifest.json`, and `styles.css` into
   `<your-vault>/.obsidian/plugins/instasync/`.
2. Enable **InstaSync** in Obsidian's *Community plugins* settings.
3. Open **Settings → InstaSync**, set the **Auth server URL** (e.g. `https://auth.example.com`), and sign in.
4. Create or join a vault from the InstaSync settings. All collaborators must join the same vault.
5. Each client gets a random two-word cursor name; reroll it with the dice button.

The status bar shows `InstaSync: connecting… / live / error`.

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
