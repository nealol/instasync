import type { StreamAnchor, StreamResult } from "./types";

/** Server limit: max UTF-8 bytes inserted per streaming session. */
export const MAX_STREAM_BYTES = 2 * 1024 * 1024;
/** Backpressure: pause `write()` while this many bytes are unacknowledged.
 * 256KB balances responsiveness with throughput — small enough that the stream
 * stays interactive, large enough to avoid stalling on per-frame ack latency. */
const HIGH_WATER_BYTES = 256 * 1024;

/** The subset of the WebSocket API the stream client needs (browser/Node/ws). */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: any) => void,
  ): void;
  readonly readyState: number;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface NoteStreamOptions {
  /**
   * WebSocket endpoint, e.g. `wss://host/api/vaults/{id}/stream` (the
   * `streamUrl` of a cursor grant, or built from a base URL via
   * {@link streamUrlFor}).
   */
  url: string;
  /** Cursor bearer token (sent as `?token=` — WebSocket clients can't set headers portably). */
  token: string;
  /** Vault-relative note path to stream into. */
  path: string;
  /** Where to insert; defaults to appending at the end of the note. */
  anchor?: StreamAnchor;
  /** Override the WebSocket implementation (defaults to `globalThis.WebSocket`, then `ws`). */
  webSocket?: WebSocketConstructor;
}

/** Build the streaming WebSocket URL from a server base URL and vault id. */
export function streamUrlFor(baseUrl: string, vaultId: string): string {
  return `${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/api/vaults/${vaultId}/stream`;
}

interface ServerFrame {
  type: "started" | "ack" | "done" | "error";
  guid?: string;
  position?: number;
  applied?: number;
  auditId?: string | null;
  inserted?: number;
  code?: string;
  message?: string;
}

/** Thrown when the server reports a fatal streaming error frame. */
export class StreamError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StreamError";
    this.code = code;
  }
}

async function resolveWebSocket(custom?: WebSocketConstructor): Promise<WebSocketConstructor> {
  if (custom) return custom;
  const global = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (global) return global;
  try {
    const ws = await import("ws");
    return ws.WebSocket as unknown as WebSocketConstructor;
  } catch {
    throw new Error(
      "No WebSocket implementation found. Use Node >= 21 (global WebSocket), " +
        "install the `ws` package, or pass `webSocket` explicitly.",
    );
  }
}

const utf8 = new TextEncoder();

/**
 * A live token-streaming session into one note. Text sent with `write()`
 * appears in the note (and in collaborators' editors) in near-realtime, with
 * a named remote caret; `end()` commits and returns the audit entry.
 *
 * Server limits: 60s idle timeout, 15min max session, 2MB per session
 * (enforced client-side too, so oversize writes fail fast).
 */
export class NoteStream {
  private ws: WebSocketLike;
  /** Note guid + resolved byte position, from the `started` frame. */
  readonly guid: string;
  readonly position: number;

  private sentBytes = 0;
  private ackedBytes = 0;
  private ended = false;
  private fatal: Error | null = null;
  /** Wakes pending write()/end() waiters after each server frame / close. */
  private wakeups = new Set<() => void>();
  private result: StreamResult | null = null;
  private closed = false;

  private constructor(ws: WebSocketLike, guid: string, position: number) {
    this.ws = ws;
    this.guid = guid;
    this.position = position;
  }

  /** Connect, send the `start` frame, and resolve once the server anchors the stream. */
  static async open(opts: NoteStreamOptions): Promise<NoteStream> {
    const WS = await resolveWebSocket(opts.webSocket);
    const url = new URL(opts.url);
    url.searchParams.set("token", opts.token);
    const ws = new WS(url.toString());

    let started: ServerFrame;
    try {
      started = await new Promise<ServerFrame>((resolve, reject) => {
        ws.addEventListener("open", () => {
          ws.send(
            JSON.stringify({
              type: "start",
              path: opts.path,
              anchor: opts.anchor ?? { mode: "append" },
            }),
          );
        });
        ws.addEventListener("message", (event: { data: unknown }) => {
          const frame = parseFrame(event.data);
          if (!frame) return;
          if (frame.type === "started") resolve(frame);
          else if (frame.type === "error")
            reject(new StreamError(frame.code ?? "error", frame.message ?? "stream error"));
        });
        ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")));
        ws.addEventListener("close", (event: { code?: number; reason?: string }) => {
          reject(
            new Error(
              `WebSocket closed before start: ${event.code ?? ""} ${event.reason ?? ""}`.trim(),
            ),
          );
        });
      });
    } catch (e) {
      // Clean up the WebSocket if the start handshake failed.
      ws.close();
      throw e;
    }

    const stream = new NoteStream(ws, started.guid ?? "", started.position ?? 0);
    stream.listen();
    return stream;
  }

  private listen(): void {
    this.ws.addEventListener("message", (event: { data: unknown }) => {
      const frame = parseFrame(event.data);
      if (!frame) return;
      if (frame.type === "ack") {
        this.ackedBytes += frame.applied ?? 0;
      } else if (frame.type === "done") {
        this.result = { auditId: frame.auditId ?? null, inserted: frame.inserted ?? 0 };
        this.fatal = null;
      } else if (frame.type === "error") {
        this.fatal = new StreamError(frame.code ?? "error", frame.message ?? "stream error");
      }
      this.wake();
    });
    this.ws.addEventListener("close", () => {
      this.closed = true;
      this.wake();
    });
    this.ws.addEventListener("error", () => {
      this.fatal ??= new Error("WebSocket error");
      this.wake();
    });
  }

  private wake(): void {
    for (const fn of [...this.wakeups]) fn();
  }

  private waitForWake(): Promise<void> {
    return new Promise((resolve) => {
      const fn = () => {
        this.wakeups.delete(fn);
        resolve();
      };
      this.wakeups.add(fn);
    });
  }

  /**
   * Stream a chunk of text. Resolves immediately while the unacknowledged
   * window is below the high-water mark, otherwise waits for server acks.
   */
  async write(text: string): Promise<void> {
    if (this.ended) throw new Error("stream already ended");
    if (this.fatal) throw this.fatal;
    if (text.length === 0) return;
    const bytes = utf8.encode(text).length;
    if (this.sentBytes + bytes > MAX_STREAM_BYTES) {
      throw new StreamError(
        "too_large",
        `write would exceed the ${MAX_STREAM_BYTES}-byte session limit`,
      );
    }
    while (this.sentBytes - this.ackedBytes >= HIGH_WATER_BYTES) {
      if (this.fatal) throw this.fatal;
      if (this.closed) throw new Error("WebSocket closed mid-stream");
      await this.waitForWake();
    }
    if (this.fatal) throw this.fatal;
    if (this.closed) throw new Error("WebSocket closed mid-stream");
    this.ws.send(JSON.stringify({ type: "text", text }));
    this.sentBytes += bytes;
  }

  /** Finish the session; resolves with the commit result from the `done` frame. */
  async end(): Promise<StreamResult> {
    if (this.ended) throw new Error("stream already ended");
    this.ended = true;
    if (this.result === null && !this.closed) {
      this.ws.send(JSON.stringify({ type: "end" }));
    }
    while (this.result === null && !this.closed) {
      await this.waitForWake();
    }
    this.ws.close();
    if (this.result) return this.result;
    if (this.fatal) throw this.fatal;
    throw new Error("WebSocket closed before done frame");
  }

  /** Abort without committing the remainder (the server still audits applied text). */
  abort(): void {
    this.ended = true;
    this.ws.close();
  }
}

/**
 * One-shot convenience: stream every chunk of `text` into `path`, then commit.
 */
export async function streamText(
  opts: NoteStreamOptions & { text: AsyncIterable<string> | Iterable<string> },
): Promise<StreamResult> {
  const stream = await NoteStream.open(opts);
  try {
    for await (const chunk of opts.text) await stream.write(chunk);
    return await stream.end();
  } catch (e) {
    stream.abort();
    throw e;
  }
}

function parseFrame(data: unknown): ServerFrame | null {
  if (typeof data !== "string") {
    if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
    else if (ArrayBuffer.isView(data as ArrayBufferView))
      data = new TextDecoder().decode(data as Uint8Array);
    else data = String(data);
  }
  try {
    return JSON.parse(data as string) as ServerFrame;
  } catch {
    return null;
  }
}
