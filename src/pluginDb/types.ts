export interface OpenSyncedDatabaseOptions {
	pluginId: string;
	name: string;
	/**
	 * Runs before sync starts. Tables that should sync must be converted by the
	 * caller with `SELECT crsql_as_crr('table_name')`.
	 */
	schema?: (db: SyncedDatabase) => Promise<void>;
}

export interface DeleteSyncedDatabaseOptions {
	pluginId: string;
	name: string;
}

export interface SyncedDatabase {
	exec(sql: string, params?: unknown[]): Promise<void>;
	query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
	transaction<T>(fn: (db: SyncedDatabase) => Promise<T>): Promise<T>;
	close(): Promise<void>;
	onStatus(cb: (status: SyncedDatabaseStatus) => void): () => void;
}

export type SyncedDatabaseStatus = "opening" | "syncing" | "synced" | "offline" | "error";

export interface CrSqliteChangeRow {
	table: string;
	pk: EncodedSqlValue;
	cid: string;
	val: EncodedSqlValue;
	colVersion: number;
	dbVersion: number;
	siteId: string;
	cl: number;
	seq: number;
}

export interface PluginDbChangeBatch {
	id: string;
	siteId: string;
	fromDbVersion: number;
	toDbVersion: number;
	changes: CrSqliteChangeRow[];
	createdAt: number;
}

export type EncodedSqlValue =
	| null
	| number
	| string
	| { type: "blob"; encoding: "base64"; data: string };

export interface SqlDatabaseAdapter {
	exec(sql: string, params?: unknown[]): Promise<void>;
	query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
	transaction<T>(fn: () => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

export interface SyncedPluginDatabaseDeps {
	openSqliteDatabase?: (name: string) => Promise<SqlDatabaseAdapter>;
	makeDoc?: (serverDocId: string) => { ydoc: import("yjs").Doc; provider?: any; persistence?: { whenSynced?: Promise<void>; destroy?: () => unknown } };
	checkpointStore?: PluginDbCheckpointStore;
}

export interface PluginDbCheckpointStore {
	read(path: string): Promise<string | null>;
	write(path: string, data: string): Promise<void>;
	delete(path: string): Promise<void>;
}
