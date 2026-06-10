// vitest setup (jsdom environment): provide the browser-ish globals that
// @y-sweet/client and y-indexeddb expect under Node.
import "fake-indexeddb/auto";
import WS from "ws";

// Force the `ws` implementation as the global WebSocket. On Node 22+ a global
// (undici) WebSocket already exists, but it clashes with jsdom's separate `Event`
// class ("event argument must be an instance of Event"); `ws` is a clean Node
// implementation the y-sweet provider drives without that mismatch.
(globalThis as any).WebSocket = WS as unknown as typeof WebSocket;

// Opt-in sync diagnostics for debugging test failures:
//   REALTIME_DEBUG=1 npx vitest run tests/unit/document.test.ts
if (process.env.REALTIME_DEBUG) {
	const { setDiagnosticLoggingEnabled } = await import("../../src/debug");
	setDiagnosticLoggingEnabled(true);
}
