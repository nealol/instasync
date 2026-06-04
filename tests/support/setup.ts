// vitest setup (jsdom environment): provide the browser-ish globals that
// @y-sweet/client and y-indexeddb expect under Node.
import "fake-indexeddb/auto";
import WS from "ws";

// Force the `ws` implementation as the global WebSocket. On Node 22+ a global
// (undici) WebSocket already exists, but it clashes with jsdom's separate `Event`
// class ("event argument must be an instance of Event"); `ws` is a clean Node
// implementation the y-sweet provider drives without that mismatch.
(globalThis as any).WebSocket = WS as unknown as typeof WebSocket;
