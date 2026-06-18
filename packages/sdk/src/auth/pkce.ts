/** PKCE (RFC 7636) helpers, isomorphic via Web Crypto. */

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 =
    typeof btoa === "function"
      ? btoa(binary)
      : // Node without btoa (>=20 has it, but stay defensive)
        Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A 32-byte random code verifier (43 base64url chars). */
export function generateVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** S256 code challenge: base64url(sha256(verifier)). */
export async function challengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Random URL-safe state parameter. */
export function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
