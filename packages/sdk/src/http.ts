import { AuthError, errorForStatus } from "./errors";

/**
 * Supplies bearer tokens for API calls. Implementations range from a static
 * string to OAuth tokens that refresh themselves.
 */
export interface TokenProvider {
  getToken(): string | Promise<string>;
  /**
   * Called once after a 401. Return a fresh token to retry the request, or
   * null to give up (the AuthError is then thrown to the caller).
   */
  onUnauthorized?(): Promise<string | null>;
}

export function staticToken(token: string): TokenProvider {
  return { getToken: () => token };
}

export interface HttpOptions {
  /** Server origin, e.g. `https://realtime.example.com` (no trailing slash needed). */
  baseUrl: string;
  auth: TokenProvider;
  /** Override for tests; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  body?: unknown;
  query?: Query;
  headers?: Record<string, string>;
}

export interface RawRequestOptions {
  body?: BodyInit;
  query?: Query;
  headers?: Record<string, string>;
}

/** Strip trailing slashes so path concatenation is unambiguous. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Encode a vault-relative file path for use inside a `{*path}` route segment:
 * each component is percent-encoded but the `/` separators are preserved.
 */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export class Http {
  readonly baseUrl: string;
  private auth: TokenProvider;
  private fetchImpl: typeof fetch;

  constructor(opts: HttpOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.auth = opts.auth;
    // Bind to globalThis: an unbound fetch reference throws "Illegal invocation".
    this.fetchImpl = opts.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  url(path: string, query?: Query): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** One JSON request; 401s retry once via `TokenProvider.onUnauthorized`. */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.send(method, path, {
      query: opts.query,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      headers: {
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
      },
    });
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** A request with a caller-managed body/response (attachments, blobs). */
  async raw(method: string, path: string, opts: RawRequestOptions = {}): Promise<Response> {
    return this.send(method, path, opts);
  }

  private async send(
    method: string,
    path: string,
    opts: RawRequestOptions,
    retried = false,
  ): Promise<Response> {
    const token = await this.auth.getToken();
    const res = await this.fetchImpl(this.url(path, opts.query), {
      method,
      headers: { Authorization: `Bearer ${token}`, ...opts.headers },
      body: opts.body,
    });
    if (res.ok) return res;
    if (res.status === 401 && !retried && this.auth.onUnauthorized) {
      const fresh = await this.auth.onUnauthorized();
      if (fresh !== null) return this.send(method, path, opts, true);
    }
    throw errorForStatus(res.status, await errorMessage(res));
    // (404s on binary routes have empty bodies; errorMessage falls back to "HTTP 404".)
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body?.error === "string" && body.error.length > 0) return body.error;
  } catch {
    // non-JSON or empty body
  }
  return `HTTP ${res.status}`;
}

export { AuthError };
