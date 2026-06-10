# Streaming tokens into a note

Remote cursors can stream text (e.g. LLM output) into a note over a WebSocket.
Connected editors see the text appear in realtime, plus a live named caret for
the cursor, exactly like a human collaborator typing.

## Endpoint

```
GET {server}/api/vaults/{vaultId}/stream
```

Upgrade to WebSocket. Authenticate with the cursor's secret token, either via
`Authorization: Bearer <token>` or — for browser WebSocket clients that cannot
set headers — a `?token=<token>` query parameter.

Plugin-managed cursors get `streamUrl` and `token` from
`app.plugins.plugins["realtime"].cursors.acquire({ pluginId })`.

## Protocol

All client→server frames are JSON text frames:

| Frame | Shape |
| --- | --- |
| start | `{"type":"start","path":"Notes/x.md","anchor":…}` (must be first) |
| text  | `{"type":"text","text":"chunk"}` (repeat per token/chunk) |
| end   | `{"type":"end"}` (commit and close) |

`anchor` selects the insertion point:

- `{"mode":"append"}` — end of the note (default)
- `{"mode":"after","text":"## Draft"}` — after the first occurrence of `text`
- `{"mode":"offset","offset":42}` — UTF-8 byte offset (must be a char boundary)

Server→client frames:

- `{"type":"started","guid":…,"position":…}` — anchor resolved, stream away
- `{"type":"ack","applied":N}` — a batch of N bytes was applied to the doc
- `{"type":"error","code":…,"message":…}` — fatal; the connection closes
- `{"type":"done","auditId":…,"inserted":N}` — final frame after end/disconnect

The insertion point is tracked as a Yjs relative position: humans editing the
same note concurrently shift the stream position instead of corrupting it, and
successive batches always chain after the cursor's own last character.

Limits: token batches are flushed every ~150 ms; sessions are committed and
closed after 60 s without frames, 15 minutes total, or 2 MB of inserted text.

Each session that inserted text produces one Git commit attributed to the
cursor (`On-Behalf-Of` the owning user) and one audit-log entry (visible under
Settings → Remote Cursors → Audit log, undoable for ~3 days).

## Example: stream an LLM response (Node 22+)

```js
// node stream_tokens.mjs <server> <vaultId> <cursorToken> <notePath>
const [server, vaultId, token, path] = process.argv.slice(2);

const ws = new WebSocket(
  `${server.replace(/^http/, "ws")}/api/vaults/${vaultId}/stream?token=${encodeURIComponent(token)}`,
);

ws.onmessage = (event) => console.log("<-", event.data);
ws.onopen = async () => {
  ws.send(JSON.stringify({ type: "start", path, anchor: { mode: "append" } }));

  // Replace with your LLM stream, e.g. for await (const chunk of stream) …
  for (const chunk of "The quick brown fox jumps over the lazy dog. ".split(/(?= )/)) {
    ws.send(JSON.stringify({ type: "text", text: chunk }));
    await new Promise((r) => setTimeout(r, 120));
  }

  ws.send(JSON.stringify({ type: "end" }));
};
```
