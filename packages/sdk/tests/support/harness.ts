// SDK e2e harness: re-exports the repo's Rust-server-in-mock-mode helpers
// (temp SQLite DB, mock OIDC, bundled y-sweet) plus a few SDK-test utilities.

import * as net from "node:net";

export {
  startAuthHarness,
  startAuthServer,
  mockLogin,
  type AuthHarness,
  type AuthServer,
} from "../../../../tests/support/authServer.js";

/** Reserve an OS-assigned free port (close immediately; caller re-binds). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * An `openBrowser` stub that performs the navigation with fetch instead of a
 * real browser, appending mock-OIDC identity params. The whole redirect chain
 * (login → callback → loopback) is followed in-process.
 */
export function fetchBrowser(sub: string): (url: string) => Promise<void> {
  return async (url) => {
    const sep = url.includes("?") ? "&" : "?";
    const res = await fetch(
      `${url}${sep}mock_sub=${encodeURIComponent(sub)}&mock_name=${encodeURIComponent(sub)}`,
      { redirect: "follow" },
    );
    if (!res.ok)
      throw new Error(`mock browser navigation failed: HTTP ${res.status} ${await res.text()}`);
  };
}
