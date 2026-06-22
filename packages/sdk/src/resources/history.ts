import type { Http } from "../http";
import type {
  HistoryCommitDetail,
  HistoryCommitListPage,
  HistoryFileAtCommit,
  HistoryRollbackPlan,
  HistoryRollbackResult,
  HistoryTreeResponse,
} from "../types";

/** Vault git history browsing + admin rollback. */
export class HistoryResource {
  constructor(
    private http: Http,
    private vaultId: string,
  ) {}

  private base(suffix = ""): string {
    return `/api/vaults/${this.vaultId}/history/commits${suffix}`;
  }

  /** Page through commit history; pass `path` for one file's history. */
  listCommits(opts?: {
    limit?: number;
    before?: string;
    path?: string;
  }): Promise<HistoryCommitListPage> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.before) params.set("before", opts.before);
    if (opts?.path) params.set("path", opts.path);
    const qs = params.toString();
    return this.http.request("GET", this.base(qs ? `?${qs}` : ""));
  }

  getCommit(hash: string): Promise<HistoryCommitDetail> {
    return this.http.request("GET", this.base(`/${hash}`));
  }

  getTree(hash: string): Promise<HistoryTreeResponse> {
    return this.http.request("GET", this.base(`/${hash}/tree`));
  }

  getFile(hash: string, path: string): Promise<HistoryFileAtCommit> {
    return this.http.request("GET", this.base(`/${hash}/file?path=${encodeURIComponent(path)}`));
  }

  /** Raw bytes of a path at a commit (shims resolve through the blob store). */
  async getBlob(hash: string, path: string): Promise<Uint8Array> {
    const res = await this.http.raw(
      "GET",
      this.base(`/${hash}/blob?path=${encodeURIComponent(path)}`),
    );
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Dry-run a rollback to `hash` (admin only). Pass `path` to scope to a single file. */
  rollbackPreview(
    hash: string,
    opts?: { path?: string; targetPath?: string },
  ): Promise<HistoryRollbackPlan> {
    if (opts?.targetPath && !opts.path) {
      throw new Error("targetPath requires path");
    }
    const qs = new URLSearchParams();
    if (opts?.path) qs.set("path", opts.path);
    if (opts?.targetPath) qs.set("targetPath", opts.targetPath);
    const suffix = qs.toString();
    return this.http.request(
      "POST",
      this.base(`/${hash}/rollback/preview${suffix ? `?${suffix}` : ""}`),
      { body: {} },
    );
  }

  /** Execute a rollback to `hash` (admin only); `pluginDbs` opts databases in (vault scope only). */
  rollback(
    hash: string,
    opts?: { path?: string; targetPath?: string; pluginDbs?: { plugin: string; name: string }[] },
  ): Promise<HistoryRollbackResult> {
    if (opts?.targetPath && !opts.path) {
      throw new Error("targetPath requires path");
    }
    if (opts?.path && opts.pluginDbs && opts.pluginDbs.length > 0) {
      throw new Error("pluginDbs cannot be combined with path");
    }
    const qs = new URLSearchParams();
    if (opts?.path) qs.set("path", opts.path);
    if (opts?.targetPath) qs.set("targetPath", opts.targetPath);
    const suffix = qs.toString();
    return this.http.request("POST", this.base(`/${hash}/rollback${suffix ? `?${suffix}` : ""}`), {
      body: { pluginDbs: opts?.pluginDbs ?? [] },
    });
  }
}
