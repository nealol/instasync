/**
 * cr-sqlite WASM loading + the low-level `crsql_changes` read/merge helpers.
 *
 * This module is deliberately free of any Obsidian dependency so it can run
 * under vitest. The caller supplies a `locateWasm(file) => url` callback (a blob
 * URL in Obsidian, a filesystem path under node) and we keep a single shared
 * init promise per process.
 */

import initWasm, { type DB, type SQLite3 } from "@vlcn.io/crsqlite-wasm";
import type { ChangeRow, EncodedVal, SqlValue } from "./types";

let sqlitePromise: Promise<SQLite3> | null = null;

/**
 * Initialise (once) the cr-sqlite WASM runtime. `locateWasm` resolves the
 * `crsqlite.wasm` asset; it must return a same-origin (blob:/data:) URL to avoid
 * CORS on the Emscripten fetch. When omitted, the cr-sqlite package's default
 * (the esbuild-inlined data URL) is used.
 */
export function getSqlite(locateWasm?: (file: string) => string): Promise<SQLite3> {
	if (!sqlitePromise) {
		sqlitePromise = initWasm(locateWasm).catch((e) => {
			// Allow a later retry if the first attempt fails (e.g. download race).
			sqlitePromise = null;
			throw e;
		});
	}
	return sqlitePromise;
}

/** Reset the shared init promise (tests only). */
export function _resetSqliteForTests(): void {
	sqlitePromise = null;
}

/** Open a fresh in-memory database. */
export async function openMemoryDb(sqlite: SQLite3): Promise<DB> {
	// No filename => ":memory:" with no IDB VFS. Memory is the only supported mode.
	return sqlite.open();
}

// --- byte / base64 helpers ---------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	if (typeof btoa === "function") return btoa(binary);
	// Node fallback (tests).
	return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(b64: string): Uint8Array {
	if (typeof atob === "function") {
		const binary = atob(b64);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	}
	return new Uint8Array(Buffer.from(b64, "base64"));
}

export function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
	return hex.toLowerCase();
}

export function hexToBytes(hex: string): Uint8Array {
	const clean = hex.trim().toLowerCase();
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	return out;
}

// --- value encoding ----------------------------------------------------------

export function encodeVal(v: SqlValue | undefined): EncodedVal {
	if (v === null || v === undefined) return null;
	if (v instanceof Uint8Array) return { $blob: bytesToBase64(v) };
	if (typeof v === "bigint") {
		// Keep small bigints as plain numbers when safe; otherwise tag.
		if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) {
			return Number(v);
		}
		return { $int: v.toString() };
	}
	return v;
}

export function decodeVal(v: EncodedVal): SqlValue {
	if (v === null) return null;
	if (typeof v === "object") {
		if ("$blob" in v) return base64ToBytes(v.$blob);
		if ("$int" in v) {
			const big = BigInt(v.$int);
			if (big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)) {
				return Number(big);
			}
			return big;
		}
	}
	return v as SqlValue;
}

// --- crsql_changes I/O -------------------------------------------------------

const CHANGE_COLUMNS = `"table", pk, cid, val, col_version, db_version, site_id, cl, seq`;

type RawChange = [string, Uint8Array, string, SqlValue, number, number, Uint8Array, number, number];

function toChangeRow(raw: RawChange): ChangeRow {
	return {
		table: raw[0],
		pk: bytesToBase64(raw[1]),
		cid: raw[2],
		val: encodeVal(raw[3]),
		col_version: Number(raw[4]),
		db_version: Number(raw[5]),
		site_id: bytesToBase64(raw[6]),
		cl: Number(raw[7]),
		seq: Number(raw[8]),
	};
}

/** Read changes for one origin site above `sinceDbVersion`, ordered causally. */
export async function readChangesForSite(
	db: DB,
	siteIdBytes: Uint8Array,
	sinceDbVersion: number,
): Promise<ChangeRow[]> {
	const rows = await db.execA<RawChange>(
		`SELECT ${CHANGE_COLUMNS} FROM crsql_changes
		 WHERE site_id = ? AND db_version > ?
		 ORDER BY db_version, seq`,
		[siteIdBytes, sinceDbVersion],
	);
	return rows.map(toChangeRow);
}

/** Read the entire local changeset (every site), ordered causally — for snapshots/bootstrap. */
export async function readAllChanges(db: DB): Promise<ChangeRow[]> {
	const rows = await db.execA<RawChange>(
		`SELECT ${CHANGE_COLUMNS} FROM crsql_changes ORDER BY db_version, seq`,
	);
	return rows.map(toChangeRow);
}

/** Merge a batch of remote change rows. Must run inside a transaction. */
export async function applyChanges(db: DB, rows: ChangeRow[]): Promise<void> {
	for (const r of rows) {
		await db.exec(
			`INSERT INTO crsql_changes (${CHANGE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				r.table,
				base64ToBytes(r.pk),
				r.cid,
				decodeVal(r.val),
				r.col_version,
				r.db_version,
				base64ToBytes(r.site_id),
				r.cl,
				r.seq,
			] as never[],
		);
	}
}

/** Current per-database lamport clock. */
export async function currentDbVersion(db: DB): Promise<number> {
	const rows = await db.execA<[number]>(`SELECT crsql_db_version()`);
	return Number(rows[0]?.[0] ?? 0);
}

/** The distinct origin site ids currently present in `crsql_changes` (hex). */
export async function knownSiteIds(db: DB): Promise<string[]> {
	const rows = await db.execA<[Uint8Array]>(
		`SELECT DISTINCT site_id FROM crsql_changes`,
	);
	return rows.map((r) => bytesToHex(r[0]));
}

export type { DB, SQLite3 };
