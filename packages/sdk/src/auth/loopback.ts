/** Node-only: a one-shot loopback HTTP server catching an OAuth/login redirect. */

import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface LoopbackServer {
  /** Full redirect URI to register/pass, e.g. `http://127.0.0.1:53682/callback`. */
  url: string;
  /** Origin only (for ALLOWED_LOGIN_REDIRECTS allowlisting). */
  origin: string;
  port: number;
  /** Resolves with the query params of the first request to the callback path. */
  waitForCallback(opts?: { timeoutMs?: number }): Promise<URLSearchParams>;
  close(): Promise<void>;
}

const LANDING_PAGE = `<!doctype html><meta charset="utf-8"><title>Realtime</title>
<body style="font-family: system-ui; text-align: center; padding-top: 4rem">
<h2>Signed in</h2><p>You can close this window and return to your application.</p></body>`;

/**
 * Start a loopback server on 127.0.0.1. Pass `port: 0` (default) for an
 * ephemeral port; pass a fixed port when the server operator allowlisted a
 * specific origin (origin checks include the port).
 */
export async function startLoopback(
  opts: { port?: number; path?: string } = {},
): Promise<LoopbackServer> {
  const path = opts.path ?? "/callback";
  let resolveParams: ((params: URLSearchParams) => void) | null = null;
  const params = new Promise<URLSearchParams>((resolve) => {
    resolveParams = resolve;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const host = req.headers.host ?? "";
    if (host !== "127.0.0.1" && !host.startsWith("127.0.0.1:")) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(LANDING_PAGE);
    resolveParams?.(url.searchParams);
    resolveParams = null;
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    url: `${origin}${path}`,
    origin,
    port,
    waitForCallback({ timeoutMs = 5 * 60 * 1000 } = {}) {
      return new Promise<URLSearchParams>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for the browser redirect")),
          timeoutMs,
        );
        void params.then((p) => {
          clearTimeout(timer);
          resolve(p);
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Open `url` in the platform default browser (injectable in tests). */
export async function openInBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
