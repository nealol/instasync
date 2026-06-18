import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { MAX_STREAM_BYTES, NoteStream, StreamError, streamText } from "../../src/stream";

type Frame = Record<string, unknown>;

/** A scriptable fake of the server side of the streaming protocol. */
class FakeStreamServer {
  wss: WebSocketServer;
  url!: string;
  received: Frame[] = [];
  socket: ServerSocket | null = null;
  /** Override per-test; default: anchor at 0, ack every text frame, done on end. */
  onFrame: (frame: Frame, ws: ServerSocket) => void = (frame, ws) => {
    if (frame.type === "start") {
      ws.send(JSON.stringify({ type: "started", guid: "g1", position: 0 }));
    } else if (frame.type === "text") {
      ws.send(JSON.stringify({ type: "ack", applied: (frame.text as string).length }));
    } else if (frame.type === "end") {
      const inserted = this.received
        .filter((f) => f.type === "text")
        .reduce((n, f) => n + (f.text as string).length, 0);
      ws.send(JSON.stringify({ type: "done", auditId: "audit1", inserted }));
    }
  };

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => this.wss.once("listening", resolve));
    const { port } = this.wss.address() as { port: number };
    this.url = `ws://127.0.0.1:${port}/api/vaults/v1/stream`;
    this.wss.on("connection", (ws) => {
      this.socket = ws;
      ws.on("message", (data) => {
        const frame = JSON.parse(String(data)) as Frame;
        this.received.push(frame);
        this.onFrame(frame, ws);
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

describe("NoteStream", () => {
  let server: FakeStreamServer;

  beforeEach(async () => {
    server = new FakeStreamServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("sends start with the anchor and token, streams text, and resolves done", async () => {
    const stream = await NoteStream.open({
      url: server.url,
      token: "tok",
      path: "Notes/x.md",
      anchor: { mode: "after", text: "## Draft" },
    });
    expect(stream.guid).toBe("g1");
    await stream.write("hello ");
    await stream.write("world");
    const result = await stream.end();

    expect(result).toEqual({ auditId: "audit1", inserted: 11 });
    expect(server.received).toEqual([
      { type: "start", path: "Notes/x.md", anchor: { mode: "after", text: "## Draft" } },
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
      { type: "end" },
    ]);
  });

  it("defaults the anchor to append", async () => {
    const stream = await NoteStream.open({ url: server.url, token: "t", path: "a.md" });
    await stream.end();
    expect(server.received[0]).toEqual({ type: "start", path: "a.md", anchor: { mode: "append" } });
  });

  it("rejects open() when the server errors before started", async () => {
    server.onFrame = (frame, ws) => {
      if (frame.type === "start") {
        ws.send(JSON.stringify({ type: "error", code: "not_found", message: "no such note" }));
      }
    };
    await expect(
      NoteStream.open({ url: server.url, token: "t", path: "missing.md" }),
    ).rejects.toThrow("no such note");
  });

  it("propagates mid-stream error frames to write()", async () => {
    let texts = 0;
    server.onFrame = (frame, ws) => {
      if (frame.type === "start")
        ws.send(JSON.stringify({ type: "started", guid: "g", position: 0 }));
      if (frame.type === "text" && ++texts === 1) {
        ws.send(
          JSON.stringify({
            type: "error",
            code: "too_large",
            message: "session byte limit exceeded",
          }),
        );
      }
    };
    const stream = await NoteStream.open({ url: server.url, token: "t", path: "a.md" });
    await stream.write("x");
    // Wait for the error frame to arrive, then the next write must throw.
    await new Promise((r) => setTimeout(r, 100));
    await expect(stream.write("y")).rejects.toThrow(StreamError);
  });

  it("enforces the 2MB session budget client-side", async () => {
    const stream = await NoteStream.open({ url: server.url, token: "t", path: "a.md" });
    const big = "x".repeat(MAX_STREAM_BYTES + 1);
    await expect(stream.write(big)).rejects.toThrow(/session limit/);
    stream.abort();
  });

  it("counts UTF-8 bytes (not UTF-16 units) against the budget", async () => {
    const stream = await NoteStream.open({ url: server.url, token: "t", path: "a.md" });
    // 700k three-byte chars = 2.1MB > 2MB even though length is 700k.
    const big = "€".repeat(700_000);
    await expect(stream.write(big)).rejects.toThrow(/session limit/);
    stream.abort();
  });

  it("applies ack backpressure: writes pause until the server acks", async () => {
    const pendingAcks: ServerSocket[] = [];
    const ackSizes: number[] = [];
    server.onFrame = (frame, ws) => {
      if (frame.type === "start")
        ws.send(JSON.stringify({ type: "started", guid: "g", position: 0 }));
      if (frame.type === "text") {
        ackSizes.push((frame.text as string).length);
        pendingAcks.push(ws); // withhold acks until released
      }
    };
    const stream = await NoteStream.open({ url: server.url, token: "t", path: "a.md" });
    const chunk = "x".repeat(300 * 1024);
    await stream.write(chunk); // nothing unacked before the send: resolves
    let secondResolved = false;
    const second = stream.write(chunk).then(() => {
      secondResolved = true;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(secondResolved).toBe(false); // 300k unacked >= 256k high-water: blocked

    // Release the ack for the first chunk; the second write should proceed.
    for (const ws of pendingAcks.splice(0))
      ws.send(JSON.stringify({ type: "ack", applied: ackSizes[0] }));
    await second;
    expect(secondResolved).toBe(true);
    stream.abort();
  });

  it("passes the token as a query parameter", async () => {
    const seen: string[] = [];
    server.wss.removeAllListeners("connection");
    server.wss.on("connection", (ws, req) => {
      seen.push(req.url ?? "");
      ws.on("message", (data) => {
        const frame = JSON.parse(String(data)) as Frame;
        if (frame.type === "start")
          ws.send(JSON.stringify({ type: "started", guid: "g", position: 0 }));
      });
    });
    const stream = await NoteStream.open({ url: server.url, token: "secret-tok", path: "a.md" });
    stream.abort();
    expect(seen[0]).toContain("token=secret-tok");
  });

  it("streamText pipes an iterable and returns the result", async () => {
    const result = await streamText({
      url: server.url,
      token: "t",
      path: "a.md",
      text: ["one ", "two ", "three"],
    });
    expect(result.inserted).toBe(13);
    expect(server.received.filter((f) => f.type === "text")).toHaveLength(3);
  });
});
