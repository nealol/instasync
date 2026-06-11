# @realtime-md/cli

`rtmd` — a command-line client for a Realtime.md server. It binds local folders
to vaults, syncs files both ways without a daemon, and exposes most of the
server API (`@realtime-md/sdk`) as git-like subcommands.

```sh
bun run --filter @realtime-md/cli build
node packages/cli/dist/cli.js --help   # or `rtmd` once linked/installed
```

## The `.rtmd` file

Every synced folder has a `.rtmd` JSON file at its root holding the server URL,
the bound vault, the folder's credentials, and the snapshot of the last sync.
Commands locate it by walking up parent directories, like a git root. The file
is never synced (along with all dot-files/dot-directories and symlinks), and it
contains tokens — add it to `.gitignore` if the folder is also a git repo.

## Getting a folder

```sh
rtmd login [dir]          # log in, pick one of your vaults, bind the folder
rtmd clone <vault> [dir]  # log in and download a vault into a new folder
rtmd init [dir] --name N  # create a new vault from a folder's current contents
```

`login`/`clone`/`init` run a browser login (`--paste` to paste a token instead).
After picking a vault, admins are offered the **login-to-cursor** hand-off:
create a named remote cursor for the folder and store its secret token instead
of your personal session token — the folder then acts as that auditable,
vault-scoped cursor, and the temporary user session is invalidated.

Auth modes stored in `.rtmd`:

| mode | credential | acts as |
|---|---|---|
| `user` | session token | you (full API: vaults, members, cursors, rollback…) |
| `cursor` | cursor secret token | a remote cursor (vault-scoped, audited) |
| `cursor-oauth` | OAuth client + refresh tokens | a remote cursor, auto-refreshing (`clone --cursor-oauth <mcpUrl>`) |

## Syncing

```sh
rtmd status        # local + remote changes since the last sync
rtmd pull          # remote → local   (--theirs overwrites local conflicts)
rtmd push          # local → remote   (--force overwrites remote conflicts)
```

Sync is a three-way diff of local files, the `.rtmd` snapshot, and the server's
listings. `.md` files sync as notes, `.canvas`/`.base` as structured JSON docs,
everything else as binary attachments. `status` cannot see remote edits to
notes/canvases/bases (only attachments carry a listing hash); `pull` detects
them by fetching content.

## Everything else

```sh
rtmd mv <from> <to>            # move/rename remotely and locally
rtmd rm / cat / write / append / patch / ls / permalink
rtmd search <q> / tags / backlinks <path> / reindex
rtmd history log [path] / history show <hash> [path]
rtmd rollback <hash> [--yes]   # previews first; admin only
rtmd cursor list/create/rename/rm/token/audit/undo
rtmd vault list / vault create <name>
rtmd members list/promote/rm ; rtmd invite create/redeem
rtmd attach ls/get/put/from-url/rm
rtmd storage [--gc] ; rtmd backup get/set/rm/test
rtmd whoami / logout
```

Global flags: `--dir <path>` (operate on another folder), `--json`
(machine-readable output).
