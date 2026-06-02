# InstaSync

Google-Docs-style collaborative editing for Obsidian, powered by [Yjs](https://github.com/yjs/yjs) and a [y-sweet](https://github.com/drifting-in-space/y-sweet) server.

For this prototype, **every Markdown file in the vault is synced** (rather than specific shared folders). You point the plugin at one server URL, and that server hosts one vault.

## How it works

- **Vault index** — a single Yjs document (`vault id`) holds a map of `path → doc-guid`. This is how file creation/deletion/rename propagates between clients.
- **Per-file documents** — each Markdown file is its own Yjs document (a `Y.Text` named `contents`) hosted on the y-sweet server, keyed by a stable guid.
- **Editor binding** — when a file is open, a CodeMirror 6 view plugin (`src/editor/LiveEdit.ts`) binds the editor to the shared text in both directions. When a file is *not* open, `src/Document.ts` keeps the file on disk in sync with the shared text.
- **Live cursors** — `src/editor/RemoteSelections.ts` renders each collaborator's caret and selection, labelled with a generated **two-word name** (e.g. "Brave Otter") and a color, broadcast over Yjs awareness.

## Running a server

Use the y-sweet development server (no auth token required):

```bash
npx y-sweet@latest serve
# serves on http://127.0.0.1:8080 by default
```

Or run the included reference server in `references/y-sweet`.

## Plugin setup

1. Build the plugin:
   ```bash
   npm install
   npm run build
   ```
2. Copy `main.js`, `manifest.json`, and `styles.css` into
   `<your-vault>/.obsidian/plugins/instasync/` (or symlink this folder there).
3. Enable **InstaSync** in Obsidian's *Community plugins* settings.
4. Open **Settings → InstaSync** and set the **Server URL** (default
   `http://127.0.0.1:8080`). All collaborators must use the same URL and **Vault id**.
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
- No access control / encryption; intended for trusted, local prototyping.
