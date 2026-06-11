/** Wire types for the vault git history + rollback API. */

export interface HistoryCommit {
	hash: string;
	shortHash: string;
	parents: string[];
	authorName: string;
	authorEmail: string;
	timestampMs: number;
	subject: string;
	principalId?: string;
	principalType?: string;
	cursorId?: string;
	cursorName?: string;
	onBehalfOf?: string;
	rollbackOf?: string;
}

export interface CommitListPage {
	commits: HistoryCommit[];
	hasMore: boolean;
}

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "other";

export interface CommitChange {
	path: string;
	status: ChangeStatus;
	renamedTo?: string;
	kind: string;
}

export interface CommitDetail {
	commit: HistoryCommit;
	changes: CommitChange[];
}

export interface HistoryTreeEntry {
	path: string;
	size: number;
	kind: string;
}

export interface HistoryTree {
	entries: HistoryTreeEntry[];
}

export type FileAtCommit =
	| { type: "text"; content: string; lang: string }
	| { type: "binary"; hash: string; size: number; inline: boolean; blobAvailable: boolean }
	| { type: "absent" };

export interface PlannedChange {
	path: string;
	kind: string;
	action: "create" | "modify" | "delete" | "restoreBlob";
}

export interface UnrecoverableBinary {
	path: string;
	hash: string;
	currentKept: boolean;
}

export interface PluginDbPlan {
	plugin: string;
	name: string;
	changed: boolean;
	rollbackable: boolean;
	reason?: string;
}

export interface RollbackPlan {
	targetCommit: string;
	changes: PlannedChange[];
	unrecoverableBinaries: UnrecoverableBinary[];
	pluginDbs: PluginDbPlan[];
}

export interface RollbackResult {
	commit: string | null;
	applied: number;
	deleted: number;
	blobsRestored: number;
	pluginDbsRolledBack: number;
	unrecoverableBinaries: UnrecoverableBinary[];
}
