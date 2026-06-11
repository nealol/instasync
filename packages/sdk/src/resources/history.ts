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

	/** Dry-run a rollback to `hash` (admin only). */
	rollbackPreview(hash: string): Promise<HistoryRollbackPlan> {
		return this.http.request("POST", this.base(`/${hash}/rollback/preview`), { body: {} });
	}

	/** Execute a rollback to `hash` (admin only); `pluginDbs` opts databases in. */
	rollback(
		hash: string,
		pluginDbs: { plugin: string; name: string }[] = [],
	): Promise<HistoryRollbackResult> {
		return this.http.request("POST", this.base(`/${hash}/rollback`), { body: { pluginDbs } });
	}
}
