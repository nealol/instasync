# InstaSync auth server

A small [axum](https://github.com/tokio-rs/axum) service that owns SSO accounts,
vaults, sharing/invites, and **mints y-sweet document tokens** after access
checks. The Obsidian plugin talks to this server over HTTPS; the actual CRDT sync
runs against a **stock y-sweet** server started with a shared `--auth` key.

```
Obsidian plugin ──HTTPS──▶ auth server   (login, /api/me, vaults, invites, doc-token)
Obsidian plugin ──WSS────▶ y-sweet       (stock binary, --auth <key>, sync only)
                              ▲
              auth server ────┘ (server-token bearer: ensure doc + relay /doc/{id}/auth)
```

The auth server holds the **same private key** as y-sweet (via `y-sweet-core`'s
`Authenticator`), so the client tokens it relays are accepted by y-sweet.

## Running

1. Generate a shared key:

   ```sh
   y-sweet gen-auth --json     # -> { "private_key": "...", ... }
   ```

2. Start y-sweet with that key:

   ```sh
   y-sweet serve --auth <private_key> --port 8080
   ```

3. Start the auth server with the **same** key:

   ```sh
   export YSWEET_AUTH_KEY=<private_key>
   export YSWEET_URL=http://127.0.0.1:8080
   export OIDC_MODE=oidc
   export OIDC_ISSUER=https://id.example.com
   export OIDC_CLIENT_ID=...
   export OIDC_CLIENT_SECRET=...
   cargo run --release
   ```

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite://instasync.db?mode=rwc` | SeaORM sqlite URL |
| `BIND_ADDR` | `127.0.0.1:8081` | listen address |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:8081` | this server's public URL (OIDC redirect default) |
| `YSWEET_URL` | `http://127.0.0.1:8080` | internal URL used to reach y-sweet |
| `YSWEET_PUBLIC_URL` | = `YSWEET_URL` | URL clients connect to (host rewritten into tokens) |
| `YSWEET_AUTH_KEY` | — | shared private key (same as `y-sweet serve --auth`) |
| `OIDC_MODE` | `oidc` | `oidc` for a real IdP, `mock` for the in-process test issuer |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URL` | — | OIDC config (real mode) |

> If y-sweet and the auth server are on different hosts, also start y-sweet with
> `--url-prefix <YSWEET_PUBLIC_URL>` so the relayed token URLs resolve for clients.

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
vault create/list, single-use invites (second redeem 409), promote, and
`/api/doc-token` scope + default-allow ACL + host rewrite, plus unit tests for the
invite word generator and token host-rewrite.
