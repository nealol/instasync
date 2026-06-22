import { errorForStatus } from "../errors";
import { normalizeBaseUrl, type TokenProvider } from "../http";
import type { OAuthRegisteredClient, OAuthServerMetadata, OAuthTokens } from "../types";
import { challengeS256, generateState, generateVerifier } from "./pkce";

export interface OAuthClientOptions {
  /** Server origin, e.g. `https://realtime.example.com`. */
  baseUrl: string;
  fetch?: typeof fetch;
}

export interface AuthorizeUrlOptions {
  clientId: string;
  redirectUri: string;
  /**
   * The protected resource being delegated: the cursor's MCP URL
   * (`{baseUrl}/mcp/i/{appId}`, the `mcpUrl` of a RemoteCursorInfo).
   */
  resource: string;
  scope?: string;
  state?: string;
}

export interface ExchangeCodeOptions {
  code: string;
  verifier: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

/**
 * OAuth 2.1 client for the Realtime server: dynamic registration, PKCE
 * authorization, code exchange, and refresh. The token endpoint is
 * form-encoded; only S256 challenges are supported.
 */
export class OAuthClient {
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private metadata: OAuthServerMetadata | null = null;

  constructor(opts: OAuthClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.fetchImpl = opts.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  /** Fetch (and cache) `/.well-known/oauth-authorization-server`. */
  async discover(): Promise<OAuthServerMetadata> {
    if (this.metadata) return this.metadata;
    const res = await this.fetchImpl(`${this.baseUrl}/.well-known/oauth-authorization-server`);
    if (!res.ok) throw errorForStatus(res.status, "OAuth discovery failed");
    this.metadata = (await res.json()) as OAuthServerMetadata;
    return this.metadata;
  }

  /** Dynamic client registration. Public client unless an auth method is given. */
  async register(opts: {
    redirectUris: string[];
    tokenEndpointAuthMethod?: "none" | "client_secret_post";
  }): Promise<OAuthRegisteredClient> {
    const meta = await this.discover();
    const res = await this.fetchImpl(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: opts.redirectUris,
        token_endpoint_auth_method: opts.tokenEndpointAuthMethod,
      }),
    });
    if (!res.ok) throw errorForStatus(res.status, await oauthError(res));
    return (await res.json()) as OAuthRegisteredClient;
  }

  /** Build the authorization URL plus the PKCE verifier/state to keep. */
  async authorizeUrl(
    opts: AuthorizeUrlOptions,
  ): Promise<{ url: string; verifier: string; state: string }> {
    const meta = await this.discover();
    const verifier = generateVerifier();
    const state = opts.state ?? generateState();
    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", opts.clientId);
    url.searchParams.set("redirect_uri", opts.redirectUri);
    url.searchParams.set("code_challenge", await challengeS256(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", opts.resource);
    if (opts.scope) url.searchParams.set("scope", opts.scope);
    url.searchParams.set("state", state);
    return { url: url.toString(), verifier, state };
  }

  exchangeCode(opts: ExchangeCodeOptions): Promise<OAuthTokens> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      code: opts.code,
      code_verifier: opts.verifier,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
    });
  }

  refresh(opts: {
    refreshToken: string;
    clientId: string;
    clientSecret?: string;
  }): Promise<OAuthTokens> {
    return this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    });
  }

  private async tokenRequest(fields: Record<string, string | undefined>): Promise<OAuthTokens> {
    const meta = await this.discover();
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.set(key, value);
    }
    const res = await this.fetchImpl(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) throw errorForStatus(res.status, await oauthError(res));
    const body = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      refresh_token: string;
      scope: string;
    };
    return {
      accessToken: body.access_token,
      tokenType: body.token_type,
      expiresIn: body.expires_in,
      refreshToken: body.refresh_token,
      scope: body.scope,
    };
  }
}

async function oauthError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; error_description?: string };
    return body.error_description ?? body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Refresh when less than this many ms of access-token lifetime remain. */
const REFRESH_MARGIN_MS = 60 * 1000;

/**
 * A {@link TokenProvider} that serves OAuth access tokens and transparently
 * refreshes them shortly before expiry (and once on a 401). Concurrent
 * refreshes are serialized.
 */
export class OAuthTokenProvider implements TokenProvider {
  private oauth: OAuthClient;
  private clientId: string;
  private clientSecret?: string;
  private tokens: OAuthTokens;
  private expiresAt: number;
  private refreshing: Promise<string> | null = null;
  /** Called after each successful refresh (persist the new refresh token). */
  onTokens?: (tokens: OAuthTokens) => void;

  constructor(opts: {
    oauth: OAuthClient;
    clientId: string;
    clientSecret?: string;
    tokens: OAuthTokens;
  }) {
    this.oauth = opts.oauth;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.tokens = opts.tokens;
    this.expiresAt = Date.now() + opts.tokens.expiresIn * 1000;
  }

  async getToken(): Promise<string> {
    if (Date.now() < this.expiresAt - REFRESH_MARGIN_MS) return this.tokens.accessToken;
    return this.refresh();
  }

  async onUnauthorized(): Promise<string | null> {
    try {
      return await this.refresh();
    } catch {
      return null;
    }
  }

  private refresh(): Promise<string> {
    this.refreshing ??= (async () => {
      try {
        const fresh = await this.oauth.refresh({
          refreshToken: this.tokens.refreshToken,
          clientId: this.clientId,
          clientSecret: this.clientSecret,
        });
        this.tokens = fresh;
        this.expiresAt = Date.now() + fresh.expiresIn * 1000;
        // Isolate user callback errors so a throwing onTokens doesn't fail the
        // refresh — the tokens were already refreshed successfully.
        try {
          this.onTokens?.(fresh);
        } catch (e) {
          console.error("Token callback error:", e);
        }
        return fresh.accessToken;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}
