/**
 * Public links for files in the active Realtime vault.
 */
export interface RealtimeShares {
  /**
   * Create or retrieve a public URL for the Markdown note at `path`.
   */
  getNoteUrl(path: string): Promise<string>;

  /**
   * Create or retrieve a public URL for the binary attachment at `path`.
   *
   * The URL exposes only the attachment version current when this method is
   * called. It stops resolving if the attachment changes or its public share
   * is revoked.
   */
  getAttachmentUrl(path: string): Promise<string>;
}
