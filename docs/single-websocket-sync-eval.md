# Evaluation: multiplexing sync WebSockets to optimize the client

Goal: have the Obsidian client pack vault sync into bounded WebSocket shards instead
of opening one socket per Yjs document.

## 1. Current architecture (the problem)

Every collaboratively-synced thing is its own Yjs document, and **each Yjs doc gets
its own `YSweetProvider`, which opens its own WebSocket** to
`wss://{PUBLIC_BASE_URL}/d/{docId}/...?token=...`.

Connection sources:

| Source | File | Doc id | Socket per |
| --- | --- | --- | --- |
| Vault index (`files`/`structured`/`trash` maps) | `src/VaultSync.ts:149` | `{vaultId}` | vault (1) |
| Each Markdown file | `src/Document.ts` via `src/SyncedDoc.ts:47` | `{vaultId}__{guid}` | file |
| Each canvas/base | `src/StructuredDocument.ts` via `SyncedDoc` | `{vaultId}__{guid}` | file |
| Each plugin SQLite DB | `src/pluginDb/obsidianDeps.ts:114` | `{vaultId}__plugindb__{plugin}__{name}` | plugin db |
| Binary attachments | `src/BinarySync.ts` | — | **none** (HTTP blob store, not WS) |

Because *the whole vault is synced*, a vault with N notes opens up to **N+ persistent
sockets**. `pumpDocQueue` (`src/VaultSync.ts:436`) throttles how many docs *connect at
once* (1 on mobile, 2 on desktop), but once a doc syncs it **stays connected for the
session** — there is no idle disconnect anywhere in `src/` (`disconnect()` is never
called on a doc provider). So steady state ≈ one open socket per file.

Per-socket client cost:
- A full `YSweetProvider`: reconnect/backoff loop, awareness, encoders, timers, an
  `IndexeddbPersistence` instance, and event listeners.
- A separate auth-server **token mint** per doc, serialized through the global token
  queue in `src/ysweet.ts` (`waitForTokenAttemptSlot` + 30s backoff) → slow cold start
  proportional to file count.
- On a network flap, N independent reconnect attempts.
- Browser/Electron per-host socket pressure; on mobile, N sockets = more radio wakeups
  and battery.

Server side (`server/src/proxy.rs`): `/d/*` is a dumb per-connection passthrough —
each client socket spawns a dedicated TCP+WS to the internal y-sweet plus a git/search
attribution tap (`relay_ws`, `is_content_write`). So fan-out is also N upstream sockets.

## 2. Key enabler

`YSweetProvider` accepts a **`WebSocketPolyfill`** option — a `new (url) => WebSocket`
constructor (`YSweetProviderParams.WebSocketPolyfill`, used at `attemptToConnect` →
`new (this.WebSocketPolyfill || WebSocket)(url)`). The provider only touches the standard
WebSocket surface: `send`, `onopen`/`onmessage`/`onclose`/`onerror`, `binaryType`,
`readyState`, `close()`, and the static `OPEN`. The per-doc URL it builds is just
`clientToken.url + "/" + docId + "?token=..."` (`generateUrl`).

**Implication:** we can give every provider a *virtual* WebSocket that multiplexes over
bounded shared sockets, **without forking y-sweet or changing any provider sync /
awareness / persistence / conflict logic.**

## 3. Options

### Option A — Client-side multiplex over bounded socket shards  *(recommended)*

- Each `MuxConnection` carries at most 512 channels to `/dmux`; larger vaults open
  another connection before reaching the server's 1,024-channel hard limit.
- A `VirtualWebSocket` class implements the WS interface. On construction it parses the
  docId from the url, registers a channel, and:
  - `send(payload)` → writes `frame(channelId, payload)` on the shared socket;
  - inbound `frame(channelId, payload)` → dispatched to that channel's `onmessage`;
  - shared socket open/close/error fan out to each channel's handlers.
- Wire framing: a per-channel numeric id assigned in an `OPEN` control frame (so the
  docId string isn't repeated on every frame), plus `OPEN(docId, token)` / `CLOSE`
  control frames and acks. Data frames: `[channelId][yjs bytes]`.
- Wiring: pass the polyfill where providers are created — `src/SyncedDoc.ts:47`,
  `src/VaultSync.ts:149` (index), and `src/pluginDb/obsidianDeps.ts:114`.
- Server: new handler accepts the mux socket; for each `OPEN` frame, validate the doc
  token (reuse `principal_for_token` + the existing `Attribution` logic) and dial one
  upstream y-sweet WS for that docId — essentially the current `relay_ws` keyed by
  channel and fanned out, keeping the per-channel `is_content_write` git/search/plugindb
  tap intact.
- **Net effect: client sockets N → ceil(N / 512).** Server↔y-sweet sockets stay at N;
  y-sweet is internal/loopback.

Token model (decide here):
- *Minimal:* keep per-doc tokens, sent inside each `OPEN` control frame; the server
  validates each exactly as today. Preserves the current per-doc authorization model.
- *Later:* mint a single vault-scoped sync token (the index token already is
  vault-scoped, docId == vaultId) and authorize all channels from it.

Pros: few client sockets with no hard vault-size ceiling; no y-sweet fork;
CRDT/offline/conflict/awareness behavior unchanged (per-file Y.Docs remain).

Cons / must-handle: a new framing protocol + server demux to build and test; shared
fate (a mux drop must re-`OPEN` all active channels on reconnect — though today all
sockets already drop together on network loss); per-channel backpressure/fairness so one
large doc can't starve others.

Effort: moderate — ~1 client module (mux client + virtual WS), small wiring changes, ~1
new server route reusing `proxy.rs` internals.

### Option B — Fewer Yjs docs (data-model consolidation)

Shard files into a few "bucket" docs, or use Yjs subdocuments under the index. Subdocs
alone don't help — y-websocket/y-sweet still open a provider (socket) per subdoc.
Bucketing reduces sockets but breaks the per-file model everything relies on (per-file
history, guids, conflict UI, server git attribution by docId, permalinks) and makes one
noisy file re-sync a whole bucket. High blast radius, conflicts with the "avoid broad
refactors / preserve conflict behavior" guidelines. **Not recommended.**

### Option C — Connection lifecycle / cap  *(cheap, complementary)*

Keep per-doc sockets but actively `disconnect()` idle docs: keep only the index + the
open editor's doc + recently-active docs connected, drop the rest after sync settles, and
reconnect on demand (the machinery already exists: `ensureConnected`,
`prioritizeItem`, the doc queue). Doesn't reach "single socket" but cuts steady-state
socket count dramatically with low risk and little code. Good interim step and a useful
fallback even after A (also caps upstream fan-out).

### Option D — Replace y-sweet with a native multi-doc sync server

Largest change; discards y-sweet's tested store/protocol. Not justified for a
client-side optimization. **Not recommended.**

## 4. Recommendation

1. **Option A** as the primary path: it reduces the client to a few bounded socket shards
   with a small change to the y-sweet/CRDT/persistence stack, because
   `WebSocketPolyfill` virtualizes the transport without touching provider logic.
2. Ship/keep **Option C** as a quick win and fallback (and to cap server→y-sweet fan-out).
3. Token model: start with per-doc tokens in `OPEN` frames (smallest auth change), move to
   a vault-scoped token later if desired.
4. Out of scope: binary attachment sync (already HTTP, not WS).

## 5. Risks / things to nail down

- Reconnect: on mux-socket drop, surface close to every channel and re-`OPEN` all active
  channels; ensure each provider's own reconnect loop cooperates.
- Per-channel backpressure/fairness on the shared pipe.
- Awareness (cursor) traffic now shares the pipe — small, but include in load tests.
- Server attribution must stay **per-channel** (git/search/plugindb taps in `proxy.rs`).
- Tests: extend `tests/support/ysweetServer.ts` + peer harness; add mux unit tests
  (framing, channel routing, reconnect) and a server integration test for demux +
  attribution. Validate with `bun run typecheck`, `bun run build`, `bun run test:all`.
