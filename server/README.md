# Realtime auth server

A small [axum](https://github.com/tokio-rs/axum) service that owns SSO accounts,
vaults, sharing/invites, and **mints y-sweet document tokens** after access
checks. The Obsidian plugin talks to this server over HTTPS; the actual CRDT sync
runs against a **stock y-sweet** server that the auth server **reverse-proxies**
under `/d/*`. y-sweet mints tokens with `--url-prefix` set to this server's public
URL, so clients connect back here and never need a separate y-sweet URL.

```
                        ┌──────────── this server ────────────┐
Obsidian plugin ─HTTPS─▶│ auth (login, /api/me, vaults, …)     │
                        │   │ server-token: ensure doc + auth   │
                        │   ▼                                   │
Obsidian plugin ─WSS───▶│ /d/* proxy ──▶ y-sweet (127.0.0.1)   │
                        └──────────────────────────────────────┘
```

The auth server holds the **same private key** as y-sweet (via `y-sweet-core`'s
`Authenticator`), so the client tokens it relays are accepted by y-sweet.

**Binary files** (images, PDFs, and other non-Markdown attachments) do not go
through y-sweet — that's a text CRDT and would bloat. Instead the plugin syncs only
a `path → sha256` mapping through the CRDT index and stores the bytes in a
**content-addressed blob store** served by this server. The raw sync blob store is
under `/api/vaults/{id}/blobs/{hash}` for the matching plugin, while consumer-facing
attachment APIs live under `/api/vaults/{id}/attachments/*`. Attachments enforce an
extension allowlist, an attachment-specific size cap, SSRF checks for from-URL
fetches, and signed single-use public upload links via `/upload`.

**Remote Cursors / MCP** expose a vault-scoped MCP resource at `/mcp/i/{appId}`.
MCP clients can use OAuth 2.1 against this server, and direct REST automation can
use the generated cursor secret as a bearer token. Both paths attribute writes to
the owning user and cursor in the git audit log.

## Running with Docker (recommended)

The image bundles y-sweet and runs it internally, so you only expose **one port**
and the plugin only needs **one URL** (this server's `PUBLIC_BASE_URL`).

```sh
# 1. Generate the shared key once:
docker run --rm --entrypoint y-sweet ghcr.io/<owner>/realtime-server gen-auth --json

# 2. Run the server (y-sweet starts internally and is proxied under /d/*):
docker run -p 8081:8081 -v realtime-data:/data \
  -e YSWEET_AUTH_KEY=<private_key> \
  -e PUBLIC_BASE_URL=https://sync.example.com \
  -e OIDC_MODE=oidc \
  -e OIDC_ISSUER=https://id.example.com \
  -e OIDC_CLIENT_ID=... -e OIDC_CLIENT_SECRET=... \
  ghcr.io/<owner>/realtime-server
```

Set `PUBLIC_BASE_URL` to the URL clients reach this server at — it is baked into
the minted client tokens (as `wss://…/d/{doc}/ws`). Put `https://sync.example.com`
in the Obsidian plugin's **Auth server URL** and you're done.

## Running without Docker

1. Generate a shared key:

   ```sh
   y-sweet gen-auth --json     # -> { "private_key": "...", ... }
   ```

2. Start y-sweet with that key, pointing its `--url-prefix` at the auth server so
   minted tokens route back through the `/d/*` proxy:

   ```sh
   y-sweet serve ./ysweet-data --auth <private_key> --port 8080 \
     --url-prefix http://127.0.0.1:8081
   ```

3. Start the auth server with the **same** key:

   ```sh
   export YSWEET_AUTH_KEY=<private_key>
   export YSWEET_URL=http://127.0.0.1:8080
   export PUBLIC_BASE_URL=http://127.0.0.1:8081
   export OIDC_MODE=oidc
   export OIDC_ISSUER=https://id.example.com
   export OIDC_CLIENT_ID=...
   export OIDC_CLIENT_SECRET=...
   cargo run --release
   ```

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite://realtime.db?mode=rwc` | SeaORM sqlite URL |
| `BIND_ADDR` | `127.0.0.1:8081` | listen address |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:8081` | this server's public URL; OIDC redirect default **and** the URL baked into minted client tokens (clients connect to `/d/*` here) |
| `YSWEET_URL` | `http://127.0.0.1:8080` | internal URL used to reach (and proxy to) y-sweet |
| `BLOB_DIR` | `./blobs` | filesystem directory for the content-addressed binary blob store (use a path on the persistent volume, e.g. `/data/blobs`) |
| `YSWEET_PUBLIC_URL` | = `YSWEET_URL` | legacy host-rewrite target; leave unset when y-sweet runs with `--url-prefix` (the Docker default) |
| `YSWEET_AUTH_KEY` | — | shared private key (same as `y-sweet serve --auth`) |
| `OIDC_MODE` | `oidc` | `oidc` for a real IdP, `mock` for the in-process test issuer |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URL` | — | OIDC config (real mode) |
| `ALLOWED_LOGIN_REDIRECTS` | — | Comma-separated web origins allowed for login redirects; the public origin is always allowed |
| `CORS_ALLOWED_ORIGINS` | Obsidian app origin | Comma-separated allowed CORS origins |
| `GIT_DATA_DIR` | `./git` (`/data/git` in Docker) | Per-vault git audit/backup repository directory |
| `GIT_AUDIT_ENABLED` | enabled | Set `0` to disable git audit commits |
| `GIT_DEBOUNCE_MS` | `5000` | Idle debounce before writing a git audit commit |
| `GIT_BOT_NAME` / `GIT_BOT_EMAIL` | `Realtime` / `realtime@localhost` | Git committer identity and fallback author |
| `CURSOR_EMAIL_DOMAIN` | domain from `GIT_BOT_EMAIL`, else `localhost` | Synthetic email domain for cursor-attributed git authors |
| `GIT_REMOTE_URL` / `GIT_PUSH_ENABLED` | — / disabled | Parsed remote push config for future backup workflows |
| `DAILY_NOTE_PATH_TEMPLATE` | `Daily Notes/{{YYYY-MM-DD}}.md` | Daily periodic note template |
| `WEEKLY_NOTE_PATH_TEMPLATE` / `MONTHLY_NOTE_PATH_TEMPLATE` / `QUARTERLY_NOTE_PATH_TEMPLATE` / `YEARLY_NOTE_PATH_TEMPLATE` | — | Optional periodic note templates |
| `ATTACHMENT_FETCH_HOST_ALLOWLIST` | — | Comma-separated hostnames allowed for server-side attachment fetches from URL |
| `ATTACHMENT_ALLOWED_EXTENSIONS` | common images, `pdf`, `txt` | Comma-separated allowed attachment extensions |
| `ATTACHMENT_MAX_BYTES` | raw blob max | Per-attachment upload/fetch size cap |
| `ATTACHMENTS_PATH_MODE` | `relative` | `relative` or `subfolder`; `subfolder` requires attachment paths under `ATTACHMENTS_SUBFOLDER` |
| `ATTACHMENTS_SUBFOLDER` | — | Required for subfolder path mode and used as the default signed-upload landing directory |
| `UPLOAD_TOKEN` | `dev-upload-token-change-me` | HMAC key for signed single-use browser upload links; set a long random secret in production |

In the bundled Docker setup, `docker-entrypoint.sh` starts y-sweet on
`YSWEET_INTERNAL_PORT` (default 8080) with a `FileSystemStore` at `YSWEET_STORE`
(`/data/ysweet`) and `--url-prefix $PUBLIC_BASE_URL`. The auth server then
reverse-proxies the sync WebSocket and document HTTP endpoints under `/d/*`, so
no second port or URL is ever exposed.

## OAuth, MCP, and API docs

The server is also an OAuth 2.1 authorization server for MCP clients. Discovery is
available at `/.well-known/oauth-authorization-server`, and MCP protected resource
metadata is available at `/.well-known/oauth-protected-resource/mcp/i/{appId}`.
Tokens are opaque, hashed in SQLite, and scoped to the remote cursor's vault.

Swagger UI is served at `/docs`, with the OpenAPI JSON at `/openapi.json`. The spec
covers consumer-facing REST/auth/OAuth/upload/permalink routes and intentionally
excludes `/mcp`, `/d/*`, raw blob storage, and `/api/doc-token`.

## Mock OIDC (tests/dev)

With `OIDC_MODE=mock`, `/auth/login` short-circuits the IdP round-trip and issues
a session directly (the user can be chosen with `?mock_sub=&mock_email=&mock_name=`).
This drives the full login → session → vault → doc-token flow with no external IdP
and backs the Tier-2 / Tier-3 test harnesses.

## Tests

```sh
cargo test
```

Covers (mock OIDC + temp sqlite + a hermetic fake y-sweet): login → session,
vault create/list, single-use invites (second redeem 409), promote,
`/api/doc-token` scope + default-allow ACL + host rewrite, and the binary blob
store (PUT/HEAD/GET round-trip, bad-hash and content-mismatch rejection, auth +
membership scoping), plus unit tests for the invite word generator, token
host-rewrite, and blob hash validation.
