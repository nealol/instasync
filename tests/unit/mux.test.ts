import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MuxWebSocket,
  decodeFrame,
  encodeData,
  encodeOpen,
  encodeClose,
  resetMuxForTests,
  setMuxWebSocketCtor,
} from "../../src/sync/mux";

/**
 * A controllable stand-in for the real WebSocket the mux opens to `/dmux`.
 * Captures everything the mux sends and lets a test simulate the server side.
 */
class FakeServerSocket {
  static instances: FakeServerSocket[] = [];
  url: string;
  binaryType = "blob";
  readyState = 0; // CONNECTING
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Uint8Array[] = [];

  constructor(url: string) {
    this.url = url;
    FakeServerSocket.instances.push(this);
  }

  send(data: ArrayBuffer | Uint8Array): void {
    this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data));
  }
  close(): void {
    this.readyState = 3;
  }

  /** Test helper: complete the connection handshake. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  /** Test helper: deliver a binary frame to the mux client. */
  deliver(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.buffer.slice(0) as ArrayBuffer });
  }
  /** Test helper: the parsed frames the mux has sent so far. */
  frames() {
    return this.sent.map((f) => decodeFrame(f));
  }
}

const DOC_URL = "wss://sync.example.com/d/vault__abc/ws/vault__abc?token=t-abc";
const DOC2_URL = "wss://sync.example.com/d/vault__def/ws/vault__def?token=t-def";

beforeEach(() => {
  resetMuxForTests();
  FakeServerSocket.instances = [];
  setMuxWebSocketCtor(FakeServerSocket as unknown as { new (url: string): WebSocket });
});

describe("mux framing", () => {
  it("round-trips OPEN/DATA/CLOSE frames", () => {
    expect(decodeFrame(encodeOpen(3, "/d/x/ws/x?token=q"))).toEqual({
      type: "open",
      channelId: 3,
      pathAndQuery: "/d/x/ws/x?token=q",
    });

    const payload = new Uint8Array([0, 1, 2, 255, 9]);
    const data = decodeFrame(encodeData(7, payload));
    expect(data?.type).toBe("data");
    if (data?.type === "data") {
      expect(data.channelId).toBe(7);
      expect(Array.from(data.payload)).toEqual([0, 1, 2, 255, 9]);
    }

    expect(decodeFrame(encodeClose(5))).toEqual({ type: "close", channelId: 5 });
  });

  it("returns null on malformed input", () => {
    expect(decodeFrame(new Uint8Array([]))).toBeNull();
  });
});

describe("MuxWebSocket", () => {
  it("shares one real socket across channels and sends one OPEN each", () => {
    const a = new MuxWebSocket(DOC_URL);
    const b = new MuxWebSocket(DOC2_URL);

    // Both channels resolve to the same origin -> one real socket to /dmux.
    expect(FakeServerSocket.instances).toHaveLength(1);
    const server = FakeServerSocket.instances[0];
    expect(server.url).toBe("wss://sync.example.com/dmux");

    server.open();
    const opens = server.frames().filter((f) => f?.type === "open");
    expect(opens).toHaveLength(2);
    expect(opens.map((f) => (f?.type === "open" ? f.pathAndQuery : ""))).toEqual([
      "/d/vault__abc/ws/vault__abc?token=t-abc",
      "/d/vault__def/ws/vault__def?token=t-def",
    ]);

    expect(a.readyState).toBe(MuxWebSocket.CONNECTING);
    expect(b.readyState).toBe(MuxWebSocket.CONNECTING);
  });

  it("fires onopen on OPEN_OK and routes DATA to the right channel", () => {
    const a = new MuxWebSocket(DOC_URL);
    const b = new MuxWebSocket(DOC2_URL);
    const server = FakeServerSocket.instances[0];
    server.open();

    const aChannel = openChannelId(server, "/d/vault__abc/ws/vault__abc?token=t-abc");
    const bChannel = openChannelId(server, "/d/vault__def/ws/vault__def?token=t-def");

    const aOpen = vi.fn();
    const bMsgs: number[][] = [];
    a.onopen = aOpen;
    b.onmessage = (ev) =>
      bMsgs.push(Array.from(new Uint8Array((ev as { data: ArrayBuffer }).data)));

    server.deliver(simpleFrame(2 /* OPEN_OK */, aChannel));
    expect(aOpen).toHaveBeenCalledOnce();
    expect(a.readyState).toBe(MuxWebSocket.OPEN);

    // DATA for channel b must not leak to a.
    server.deliver(encodeData(bChannel, new Uint8Array([42, 43])));
    expect(bMsgs).toEqual([[42, 43]]);
  });

  it("send() writes a DATA frame only once open", () => {
    const a = new MuxWebSocket(DOC_URL);
    const server = FakeServerSocket.instances[0];
    server.open();
    const aChannel = openChannelId(server, "/d/vault__abc/ws/vault__abc?token=t-abc");

    a.send(new Uint8Array([1, 2, 3])); // dropped: channel not OPEN yet
    expect(server.frames().some((f) => f?.type === "data")).toBe(false);

    server.deliver(simpleFrame(2, aChannel));
    a.send(new Uint8Array([1, 2, 3]));
    const data = server.frames().find((f) => f?.type === "data");
    expect(data?.type === "data" && Array.from(data.payload)).toEqual([1, 2, 3]);
  });

  it("fans a real-socket drop out to every channel as error+close", () => {
    const a = new MuxWebSocket(DOC_URL);
    const b = new MuxWebSocket(DOC2_URL);
    const server = FakeServerSocket.instances[0];
    server.open();

    const aClose = vi.fn();
    const aErr = vi.fn();
    const bClose = vi.fn();
    a.onclose = aClose;
    a.onerror = aErr;
    b.onclose = bClose;

    server.onclose?.({});
    expect(aErr).toHaveBeenCalledOnce();
    expect(aClose).toHaveBeenCalledOnce();
    expect(bClose).toHaveBeenCalledOnce();
    expect(a.readyState).toBe(MuxWebSocket.CLOSED);
    expect(b.readyState).toBe(MuxWebSocket.CLOSED);
  });

  it("delivers a server CLOSE frame to just that channel", () => {
    const a = new MuxWebSocket(DOC_URL);
    const server = FakeServerSocket.instances[0];
    server.open();
    const aChannel = openChannelId(server, "/d/vault__abc/ws/vault__abc?token=t-abc");

    const aClose = vi.fn();
    a.onclose = aClose;
    server.deliver(simpleFrame(5 /* CLOSE */, aChannel));
    expect(aClose).toHaveBeenCalledOnce();
    expect(a.readyState).toBe(MuxWebSocket.CLOSED);
  });

  it("close() sends a CLOSE frame and stops sending", () => {
    const a = new MuxWebSocket(DOC_URL);
    const server = FakeServerSocket.instances[0];
    server.open();
    const aChannel = openChannelId(server, "/d/vault__abc/ws/vault__abc?token=t-abc");
    server.deliver(simpleFrame(2, aChannel));

    a.close();
    const close = server.frames().find((f) => f?.type === "close");
    expect(close).toEqual({ type: "close", channelId: aChannel });

    a.send(new Uint8Array([9]));
    expect(server.frames().some((f) => f?.type === "data")).toBe(false);

    // Closing the final channel releases the idle connection registry entry.
    // A later provider gets a fresh transport rather than retaining the dead
    // socket object forever.
    new MuxWebSocket(DOC_URL);
    expect(FakeServerSocket.instances).toHaveLength(2);
  });
});

/** Find the channel id the mux assigned to a given OPEN path. */
function openChannelId(server: FakeServerSocket, pathAndQuery: string): number {
  for (const frame of server.frames()) {
    if (frame?.type === "open" && frame.pathAndQuery === pathAndQuery) return frame.channelId;
  }
  throw new Error(`no OPEN frame for ${pathAndQuery}`);
}

/**
 * Build a `[type][channel]` control frame the way the server would. Test ids are
 * small (< 128), so type and channel each encode to one var-uint byte.
 */
function simpleFrame(type: number, channel: number): Uint8Array {
  return new Uint8Array([type, channel]);
}
