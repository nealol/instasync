/**
 * Snapshot serialization for a synced plugin database.
 *
 * The snapshot is the on-disk cache that lets a client reopen instantly without
 * replaying the whole Y log or hitting the server. Critically it stores the full
 * `crsql_changes` dump (NOT user-table rows) so cr-sqlite's internal site ids,
 * column clocks and tombstones survive a restart — re-inserting plain user rows
 * would mint a fresh site/clock and resurrect deletes.
 */

import type { DB } from "./crsqlite";
import { readAllChanges, applyChanges } from "./crsqlite";
import type { ChangeRow, Cursor } from "./types";
import { SYNC_FORMAT } from "./types";

export const SNAPSHOT_FORMAT = `snap-${SYNC_FORMAT}`;

export interface Snapshot {
	format: string;
	schemaVersion: number;
	/** Ordered DDL: CREATE TABLE … then `SELECT crsql_as_crr('t')` per CRR table. */
	schema: string[];
	/** Full `crsql_changes` dump (blobs base64). */
	changes: ChangeRow[];
	/** Applied-remote cursor (siteIdHex -> dbVersion). */
	cursors: Cursor;
	/** What this device has published to the Y log (siteIdHex -> dbVersion). */
	published: Cursor;
}

/**
 * Build the ordered DDL needed to recreate the CRR schema: the base
 * `CREATE TABLE` statements plus a `crsql_as_crr` call per CRR table (detected
 * by its sidecar `{table}__crsql_clock` table).
 */
export async function collectSchema(db: DB): Promise<string[]> {
	const tables = await db.execA<[string, string]>(
		`SELECT name, sql FROM sqlite_master
		 WHERE type = 'table'
		   AND name NOT LIKE 'sqlite_%'
		   AND name NOT LIKE 'crsql_%'
		   AND name NOT LIKE '%__crsql_clock'
		   AND name NOT LIKE '%__crsql_pks'
		 ORDER BY name`,
	);
	const clocks = await db.execA<[string]>(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%__crsql_clock'`,
	);
	const crrTables = new Set(clocks.map((r) => r[0].replace(/__crsql_clock$/, "")));

	const ddl: string[] = [];
	for (const [name, sql] of tables) {
		if (sql) ddl.push(sql);
		if (crrTables.has(name)) ddl.push(`SELECT crsql_as_crr('${name}')`);
	}
	return ddl;
}

export async function captureSnapshot(
	db: DB,
	schemaVersion: number,
	cursors: Cursor,
	published: Cursor,
): Promise<Snapshot> {
	const schema = await collectSchema(db);
	const changes = await readAllChanges(db);
	return {
		format: SNAPSHOT_FORMAT,
		schemaVersion,
		schema,
		changes,
		cursors: { ...cursors },
		published: { ...published },
	};
}

export function serializeSnapshot(snap: Snapshot): string {
	return JSON.stringify(snap);
}

export function parseSnapshot(text: string): Snapshot | null {
	try {
		const parsed = JSON.parse(text) as Snapshot;
		if (parsed.format !== SNAPSHOT_FORMAT) return null;
		if (!Array.isArray(parsed.schema) || !Array.isArray(parsed.changes)) return null;
		if (typeof parsed.schemaVersion !== "number") return null;
		parsed.cursors ??= {};
		parsed.published ??= {};
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Recreate the schema and merge the snapshot's changes into a fresh DB. Throws
 * if the post-restore row count does not match (so the caller can discard the
 * snapshot and bootstrap from the server). Must run on an empty database.
 */
export async function restoreSnapshot(db: DB, snap: Snapshot): Promise<void> {
	for (const stmt of snap.schema) {
		await db.exec(stmt);
	}
	await db.tx(async (tx) => {
		await applyChanges(tx as unknown as DB, snap.changes);
	});

	// Verify: every change we put in must be readable back (no silent drops).
	const after = await readAllChanges(db);
	if (after.length < snap.changes.length) {
		throw new Error(
			`snapshot restore lost rows: expected >= ${snap.changes.length}, got ${after.length}`,
		);
	}
}
