/**
 * SHA-256 of a binary buffer as lowercase hex. Used as the content address for
 * binary files: the same bytes always produce the same key, so the blob store
 * dedupes and conflict detection can compare hashes instead of bytes.
 *
 * Uses the Web Crypto API, available in Obsidian's Electron renderer.
 */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
