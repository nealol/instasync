import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

/**
 * Single-WebSocket multiplexing for y-sweet sync (prototype of "Option A").
 *
 * Each Yjs document normally opens its own `YSweetProvider`, and each provider
 * opens its own WebSocket. With the whole vault synced that is one socket per
 * file. This module collapses them onto **one real socket per server origin**:
 *
 *  - {@link MuxWebSocket} implements just enough of the `WebSocket` surface for
 *    `YSweetProvider` (it is passed via the provider's `WebSocketPolyfill`
 *    option), but instead of opening a socket it registers a *channel* on a
 *    shared {@link MuxConnection}.
 *  - {@link MuxConnection} owns the one real socket to `wss://{host}/dmux` and
 *    routes framed messages to/from the right channel.
 *
 * The server (`server/src/dmux.rs`) demultiplexes: it dials one upstream
 * y-sweet socket per channel, so the existing y-sweet protocol, auth, and
 * write-attribution are unchanged — only the *client* socket count drops to one.
 *
 * Wire frames (binary; ints are lib0 var-uints):
 *   OPEN     = [1][channelId][varString pathAndQuery]   client -> server
 *   OPEN_OK  = [2][channelId]                            server -> client
 *   OPEN_ERR = [3][channelId]                            server -> client
 *   DATA     = [4][channelId][raw yjs bytes …]           both directions
 *   CLOSE    = [5][channelId]                            both directions
 *
 * `pathAndQuery` is the per-doc URL the provider would otherwise have connected
 * to (`/d/{docId}/ws/{docId}?token=…`); the server forwards it verbatim to the
 * internal y-sweet, so it keeps minting/validating per-doc tokens exactly as
 * before.
 */

const FRAME_OPEN = 1;
const FRAME_OPEN_OK = 2;
const FRAME_OPEN_ERR = 3;
const FRAME_DATA = 4;
const FRAME_CLOSE = 5;

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

export function encodeOpen(channelId: number, pathAndQuery: string): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, FRAME_OPEN);
  encoding.writeVarUint(enc, channelId);
  encoding.writeVarString(enc, pathAndQuery);
  return encoding.toUint8Array(enc);
}

export function encodeData(channelId: number, payload: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, FRAME_DATA);
  encoding.writeVarUint(enc, channelId);
  encoding.writeUint8Array(enc, payload);
  return encoding.toUint8Array(enc);
}

export function encodeClose(channelId: number): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, FRAME_CLOSE);
  encoding.writeVarUint(enc, channelId);
  return encoding.toUint8Array(enc);
}

export type DecodedFrame =
  | { type: "open"; channelId: number; pathAndQuery: string }
  | { type: "open_ok"; channelId: number }
  | { type: "open_err"; channelId: number }
  | { type: "data"; channelId: number; payload: Uint8Array }
  | { type: "close"; channelId: number }
  | null;

export function decodeFrame(buf: Uint8Array): DecodedFrame {
  try {
    const dec = decoding.createDecoder(buf);
    const type = decoding.readVarUint(dec);
    const channelId = decoding.readVarUint(dec);
    switch (type) {
      case FRAME_OPEN:
        return { type: "open", channelId, pathAndQuery: decoding.readVarString(dec) };
      case FRAME_OPEN_OK:
        return { type: "open_ok", channelId };
      case FRAME_OPEN_ERR:
        return { type: "open_err", channelId };
      case FRAME_DATA:
        return { type: "data", channelId, payload: decoding.readTailAsUint8Array(dec) };
      case FRAME_CLOSE:
        return { type: "close", channelId };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Pluggable for tests; defaults to the platform `WebSocket`. */
type WebSocketCtor = { new (url: string): WebSocket };
let webSocketCtor: WebSocketCtor = globalThis.WebSocket as unknown as WebSocketCtor;

/** Test-only: swap the WebSocket implementation used for the real connection. */
export function setMuxWebSocketCtor(ctor: WebSocketCtor): void {
  webSocketCtor = ctor;
}

const connections = new Map<string, MuxConnection>();

/** Test-only: tear down all shared connections and registries. */
export function resetMuxForTests(): void {
  for (const conn of connections.values()) conn.destroyForTests();
  connections.clear();
}

/** One real socket to a single server origin, shared by every channel on it. */
class MuxConnection {
  private ws: WebSocket | null = null;
  private readonly channels = new Map<number, MuxWebSocket>();
  /** OPEN frames awaiting a live socket: channelId -> pathAndQuery. */
  private readonly pendingOpens = new Map<number, string>();
  private nextChannelId = 1;

  constructor(private readonly url: string) {}

  static for(url: string): MuxConnection {
    let conn = connections.get(url);
    if (!conn) {
      conn = new MuxConnection(url);
      connections.set(url, conn);
    }
    return conn;
  }

  register(channel: MuxWebSocket): number {
    const id = this.nextChannelId++;
    this.channels.set(id, channel);
    return id;
  }

  openChannel(channelId: number, pathAndQuery: string): void {
    this.pendingOpens.set(channelId, pathAndQuery);
    this.ensureSocket();
    if (this.ws && this.ws.readyState === WS_OPEN) this.flushOpens();
  }

  sendData(channelId: number, payload: Uint8Array): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(encodeData(channelId, payload));
    }
  }

  closeChannel(channelId: number): void {
    this.pendingOpens.delete(channelId);
    this.channels.delete(channelId);
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(encodeClose(channelId));
    }
  }

  private ensureSocket(): void {
    if (this.ws && (this.ws.readyState === WS_OPEN || this.ws.readyState === WS_CONNECTING)) {
      return;
    }
    const ws = new webSocketCtor(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => this.flushOpens();
    ws.onmessage = (event: MessageEvent) => this.receive(new Uint8Array(event.data as ArrayBuffer));
    ws.onclose = () => this.handleDown();
    ws.onerror = () => this.handleDown();
  }

  private flushOpens(): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    for (const [channelId, pathAndQuery] of this.pendingOpens) {
      this.ws.send(encodeOpen(channelId, pathAndQuery));
    }
    this.pendingOpens.clear();
  }

  private receive(buf: Uint8Array): void {
    const frame = decodeFrame(buf);
    if (!frame) return;
    const channel = this.channels.get(frame.channelId);
    switch (frame.type) {
      case "data":
        channel?.deliverData(frame.payload);
        break;
      case "open_ok":
        channel?.deliverOpen();
        break;
      case "open_err":
        this.channels.delete(frame.channelId);
        channel?.deliverError();
        channel?.deliverClose();
        break;
      case "close":
        this.channels.delete(frame.channelId);
        channel?.deliverClose();
        break;
      default:
        break;
    }
  }

  /** Real socket dropped: fail every channel so each provider reconnects (which
   * recreates a channel and reopens the shared socket). */
  private handleDown(): void {
    const channels = [...this.channels.values()];
    this.channels.clear();
    this.pendingOpens.clear();
    this.ws = null;
    for (const channel of channels) {
      channel.deliverError();
      channel.deliverClose();
    }
  }

  destroyForTests(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.channels.clear();
    this.pendingOpens.clear();
  }
}

type WsHandler = ((event: unknown) => void) | null;

/**
 * A virtual WebSocket handed to `YSweetProvider` via its `WebSocketPolyfill`
 * option. It exposes only what the provider touches (`binaryType`, `readyState`,
 * `send`, `close`, the four `on*` handlers, and the static `OPEN`) and routes
 * everything over a shared {@link MuxConnection}.
 */
export class MuxWebSocket {
  static readonly CONNECTING = WS_CONNECTING;
  static readonly OPEN = WS_OPEN;
  static readonly CLOSING = WS_CLOSING;
  static readonly CLOSED = WS_CLOSED;

  readonly CONNECTING = WS_CONNECTING;
  readonly OPEN = WS_OPEN;
  readonly CLOSING = WS_CLOSING;
  readonly CLOSED = WS_CLOSED;

  binaryType = "arraybuffer";
  readyState: number = WS_CONNECTING;
  onopen: WsHandler = null;
  onmessage: WsHandler = null;
  onclose: WsHandler = null;
  onerror: WsHandler = null;

  private readonly conn: MuxConnection;
  private readonly channelId: number;

  constructor(url: string) {
    const parsed = new URL(url);
    const pathAndQuery = parsed.pathname + parsed.search;
    const muxUrl = `${parsed.protocol}//${parsed.host}/dmux`;
    this.conn = MuxConnection.for(muxUrl);
    this.channelId = this.conn.register(this);
    this.conn.openChannel(this.channelId, pathAndQuery);
  }

  send(data: Uint8Array | ArrayBuffer): void {
    if (this.readyState !== WS_OPEN) return;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.conn.sendData(this.channelId, bytes);
  }

  close(): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.conn.closeChannel(this.channelId);
  }

  // --- called by MuxConnection ---------------------------------------------

  deliverOpen(): void {
    if (this.readyState !== WS_CONNECTING) return;
    this.readyState = WS_OPEN;
    this.onopen?.({});
  }

  deliverData(payload: Uint8Array): void {
    // The provider does `new Uint8Array(event.data)`, so hand it an ArrayBuffer.
    const ab = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    this.onmessage?.({ data: ab });
  }

  deliverError(): void {
    this.onerror?.({});
  }

  deliverClose(): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.onclose?.({});
  }
}
