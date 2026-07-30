import type { RealtimeShares } from "@realtime-md/plugin-api-types";
import type RealtimePlugin from "../main";

/**
 * Public, plugin-author-facing API for file links, reachable as
 * `app.plugins.plugins["realtime"].shares`.
 */
export class RealtimeSharesAPI implements RealtimeShares {
  constructor(private readonly plugin: RealtimePlugin) {}

  /** Create or retrieve a public link to a Markdown note. */
  async getNoteUrl(path: string): Promise<string> {
    const vaultId = this.requireAvailable();
    const share = await this.plugin.auth.createPublicShare(vaultId, path);
    return share.url;
  }

  /** Create or retrieve a public link to an attachment's current version. */
  async getAttachmentUrl(path: string): Promise<string> {
    const vaultId = this.requireAvailable();
    const share = await this.plugin.auth.createPublicAttachmentShare(vaultId, path);
    return share.url;
  }

  private requireAvailable(): string {
    if (!this.plugin.settings.enabled) throw new Error("Realtime is disabled in settings.");
    if (!this.plugin.auth.isLoggedIn) throw new Error("Realtime is signed out — sign in first.");
    const vaultId = this.plugin.settings.activeVaultId;
    if (!vaultId) throw new Error("Realtime has no active vault.");
    return vaultId;
  }
}
