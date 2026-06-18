/** Node-only one-call OAuth 2.1 PKCE flow for remote-cursor delegation. */

import { OAuthClient, OAuthTokenProvider } from "./oauth";
import { openInBrowser, startLoopback } from "./loopback";
import type { OAuthTokens } from "../types";
import { CursorClient } from "../cursorClient";

export interface CursorOAuthOptions {
  baseUrl: string;
  /**
   * The cursor's MCP URL (`{baseUrl}/mcp/i/{appId}` — `mcpUrl` of a
   * RemoteCursorInfo). Identifies which cursor is being delegated; the user
   * authorizing in the browser must be the cursor's creator.
   */
  mcpUrl: string;
  scope?: string;
  /** Injectable for tests; defaults to opening the platform browser. */
  openBrowser?: (url: string) => Promise<void> | void;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface CursorOAuthSession {
  tokens: OAuthTokens;
  clientId: string;
  /** Auto-refreshing provider, ready to pass to {@link CursorClient}. */
  tokenProvider: OAuthTokenProvider;
}

/**
 * Run the whole OAuth 2.1 PKCE flow for a cursor: register a public client
 * with a loopback redirect, open the browser, catch the redirect, validate
 * `state`, and exchange the code. Returns an auto-refreshing token provider
 * (access tokens live 1 hour; refresh tokens 30 days).
 *
 * ```ts
 * const { tokenProvider } = await loginCursorViaOAuth({ baseUrl, mcpUrl: cursor.mcpUrl });
 * const client = new CursorClient({ baseUrl, vaultId, tokenProvider });
 * ```
 */
export async function loginCursorViaOAuth(opts: CursorOAuthOptions): Promise<CursorOAuthSession> {
  const oauth = new OAuthClient({ baseUrl: opts.baseUrl, fetch: opts.fetch });
  const loopback = await startLoopback();
  try {
    const client = await oauth.register({ redirectUris: [loopback.url] });
    const { url, verifier, state } = await oauth.authorizeUrl({
      clientId: client.client_id,
      redirectUri: loopback.url,
      resource: opts.mcpUrl,
      scope: opts.scope,
    });
    await (opts.openBrowser ?? openInBrowser)(url);
    const params = await loopback.waitForCallback({ timeoutMs: opts.timeoutMs });
    const error = params.get("error");
    if (error) throw new Error(`authorization failed: ${params.get("error_description") ?? error}`);
    const code = params.get("code");
    if (!code) throw new Error("authorization redirect returned no code");
    if (params.get("state") !== state) throw new Error("authorization state mismatch");

    const tokens = await oauth.exchangeCode({
      code,
      verifier,
      clientId: client.client_id,
      redirectUri: loopback.url,
    });
    return {
      tokens,
      clientId: client.client_id,
      tokenProvider: new OAuthTokenProvider({ oauth, clientId: client.client_id, tokens }),
    };
  } finally {
    await loopback.close();
  }
}
