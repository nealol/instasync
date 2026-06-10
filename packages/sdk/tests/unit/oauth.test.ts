import { describe, expect, it, vi } from "vitest";
import { challengeS256, generateVerifier } from "../../src/auth/pkce";
import { OAuthClient, OAuthTokenProvider } from "../../src/auth/oauth";
import { startLoopback } from "../../src/auth/loopback";

const META = {
	issuer: "https://x.test",
	authorization_endpoint: "https://x.test/oauth/authorize",
	token_endpoint: "https://x.test/oauth/token",
	registration_endpoint: "https://x.test/oauth/register",
	code_challenge_methods_supported: ["S256"],
	grant_types_supported: ["authorization_code", "refresh_token"],
	response_types_supported: ["code"],
};

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("pkce", () => {
	it("produces the RFC 7636 appendix B challenge for the known verifier", async () => {
		// Test vector from RFC 7636 §B.
		const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
		expect(await challengeS256(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	});

	it("generates 43-char base64url verifiers", () => {
		const v = generateVerifier();
		expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(generateVerifier()).not.toBe(v);
	});
});

describe("OAuthClient", () => {
	it("builds the authorization URL with PKCE + resource", async () => {
		const fetch = vi.fn(async () => jsonResponse(200, META)) as unknown as typeof fetch;
		const oauth = new OAuthClient({ baseUrl: "https://x.test", fetch });
		const { url, verifier, state } = await oauth.authorizeUrl({
			clientId: "c1",
			redirectUri: "http://127.0.0.1:1234/callback",
			resource: "https://x.test/mcp/i/app1",
		});
		const u = new URL(url);
		expect(u.origin + u.pathname).toBe("https://x.test/oauth/authorize");
		expect(u.searchParams.get("response_type")).toBe("code");
		expect(u.searchParams.get("client_id")).toBe("c1");
		expect(u.searchParams.get("code_challenge_method")).toBe("S256");
		expect(u.searchParams.get("code_challenge")).toBe(await challengeS256(verifier));
		expect(u.searchParams.get("resource")).toBe("https://x.test/mcp/i/app1");
		expect(u.searchParams.get("state")).toBe(state);
	});

	it("form-encodes the token exchange", async () => {
		let tokenBody: string | null = null;
		let tokenContentType: string | null = null;
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("well-known")) return jsonResponse(200, META);
			tokenBody = init?.body as string;
			tokenContentType = (init?.headers as Record<string, string>)["Content-Type"];
			return jsonResponse(200, {
				access_token: "at",
				token_type: "Bearer",
				expires_in: 3600,
				refresh_token: "rt",
				scope: "vault",
			});
		}) as unknown as typeof fetch;
		const oauth = new OAuthClient({ baseUrl: "https://x.test", fetch });
		const tokens = await oauth.exchangeCode({
			code: "code1",
			verifier: "ver1",
			clientId: "c1",
			redirectUri: "http://127.0.0.1:1234/callback",
		});
		expect(tokenContentType).toBe("application/x-www-form-urlencoded");
		const form = new URLSearchParams(tokenBody!);
		expect(form.get("grant_type")).toBe("authorization_code");
		expect(form.get("code")).toBe("code1");
		expect(form.get("code_verifier")).toBe("ver1");
		expect(form.get("redirect_uri")).toBe("http://127.0.0.1:1234/callback");
		expect(form.has("client_secret")).toBe(false);
		expect(tokens).toEqual({
			accessToken: "at",
			tokenType: "Bearer",
			expiresIn: 3600,
			refreshToken: "rt",
			scope: "vault",
		});
	});

	it("surfaces error_description from token failures", async () => {
		const fetch = vi.fn(async (input: string | URL | Request) =>
			String(input).includes("well-known")
				? jsonResponse(200, META)
				: jsonResponse(400, { error: "invalid_grant", error_description: "code expired" }),
		) as unknown as typeof fetch;
		const oauth = new OAuthClient({ baseUrl: "https://x.test", fetch });
		await expect(
			oauth.exchangeCode({ code: "x", verifier: "v", clientId: "c", redirectUri: "r" }),
		).rejects.toThrow("code expired");
	});
});

describe("OAuthTokenProvider", () => {
	function makeProvider(expiresIn: number) {
		let refreshes = 0;
		const fetch = vi.fn(async (input: string | URL | Request) => {
			if (String(input).includes("well-known")) return jsonResponse(200, META);
			refreshes++;
			return jsonResponse(200, {
				access_token: `at-${refreshes}`,
				token_type: "Bearer",
				expires_in: 3600,
				refresh_token: `rt-${refreshes}`,
				scope: "",
			});
		}) as unknown as typeof fetch;
		const oauth = new OAuthClient({ baseUrl: "https://x.test", fetch });
		const provider = new OAuthTokenProvider({
			oauth,
			clientId: "c1",
			tokens: { accessToken: "at-0", tokenType: "Bearer", expiresIn, refreshToken: "rt-0", scope: "" },
		});
		return { provider, refreshCount: () => refreshes };
	}

	it("serves the current token while fresh", async () => {
		const { provider, refreshCount } = makeProvider(3600);
		expect(await provider.getToken()).toBe("at-0");
		expect(refreshCount()).toBe(0);
	});

	it("refreshes near expiry and serializes concurrent refreshes", async () => {
		const { provider, refreshCount } = makeProvider(30); // < 60s margin
		const [a, b] = await Promise.all([provider.getToken(), provider.getToken()]);
		expect(a).toBe("at-1");
		expect(b).toBe("at-1");
		expect(refreshCount()).toBe(1);
	});

	it("refreshes once on 401 via onUnauthorized", async () => {
		const { provider } = makeProvider(3600);
		expect(await provider.onUnauthorized()).toBe("at-1");
	});
});

describe("loopback server", () => {
	it("catches the redirect query and serves a landing page", async () => {
		const loopback = await startLoopback();
		try {
			const wait = loopback.waitForCallback();
			const res = await fetch(`${loopback.url}?code=abc&state=xyz`);
			expect(res.status).toBe(200);
			expect(await res.text()).toContain("close this window");
			const params = await wait;
			expect(params.get("code")).toBe("abc");
			expect(params.get("state")).toBe("xyz");
		} finally {
			await loopback.close();
		}
	});

	it("404s other paths", async () => {
		const loopback = await startLoopback({ path: "/cb" });
		try {
			const res = await fetch(`${loopback.origin}/other`);
			expect(res.status).toBe(404);
		} finally {
			await loopback.close();
		}
	});
});
