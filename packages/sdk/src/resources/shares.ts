import type { Http } from "../http";
import type { PublicShare } from "../types";

/**
 * Public read-only share links for notes (`/view/{id}` in the web viewer).
 * Shares follow the note's stable guid, so they survive renames; revoking
 * deletes the link.
 */
export class SharesResource {
  constructor(
    private http: Http,
    private vaultId: string,
  ) {}

  /** Create (or return the existing) public share link for a note. Idempotent. */
  create(path: string): Promise<PublicShare> {
    return this.http.request("POST", `/api/vaults/${this.vaultId}/shares`, { body: { path } });
  }

  /** The note's current share, or null if it is not publicly shared. */
  async get(path: string): Promise<PublicShare | null> {
    const res = await this.http.request<{ share: PublicShare | null }>(
      "GET",
      `/api/vaults/${this.vaultId}/shares`,
      { query: { path } },
    );
    return res.share;
  }

  /** Stop publicly sharing a note. Throws NotFound if it was not shared. */
  async remove(path: string): Promise<void> {
    await this.http.request("DELETE", `/api/vaults/${this.vaultId}/shares`, { query: { path } });
  }
}
