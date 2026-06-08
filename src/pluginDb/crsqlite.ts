import initWasm from "@vlcn.io/crsqlite-wasm";
import type { SqlDatabaseAdapter } from "./types";

let sqlitePromise: ReturnType<typeof initWasm> | null = null;

function wasmUrl(file: string): string {
	try {
		if (file === "crsqlite.wasm") return new URL("@vlcn.io/crsqlite-wasm/crsqlite.wasm", import.meta.url).toString();
		return file;
	} catch {
		return file;
	}
}

export async function openCrsqliteDatabase(name: string): Promise<SqlDatabaseAdapter> {
	if (!sqlitePromise) sqlitePromise = initWasm(wasmUrl);
	const sqlite = await sqlitePromise;
	const db = await sqlite.open(name);
	return {
		exec: (sql, params) => db.exec(sql, params as any),
		query: (sql, params) => db.execO(sql, params as any) as Promise<any[]>,
		transaction: async (fn) => {
			let out!: Awaited<ReturnType<typeof fn>>;
			await db.tx(async () => { out = await fn(); });
			return out;
		},
		close: () => db.close(),
	};
}

export async function crsqliteRuntimeSpike(): Promise<Record<string, unknown>> {
	const db = await openCrsqliteDatabase(":memory:");
	try {
		const json = await db.query<{ v: number }>(`SELECT json_extract('{"a":1}', '$.a') AS v`);
		await db.exec("CREATE VIRTUAL TABLE fts_test USING fts5(body)");
		let rtree = true;
		try {
			await db.exec("CREATE VIRTUAL TABLE rtree_test USING rtree(id, minX, maxX, minY, maxY)");
		} catch {
			rtree = false;
		}
		const opts = await db.query<{ fts5: number; rtree: number; omitJson: number }>(
			"SELECT sqlite_compileoption_used('ENABLE_FTS5') AS fts5, sqlite_compileoption_used('ENABLE_RTREE') AS rtree, sqlite_compileoption_used('OMIT_JSON') AS omitJson",
		);
		return { json: json[0]?.v === 1, rtreeRuntime: rtree, ...opts[0] };
	} finally {
		await db.close();
	}
}

export function encodeSqlValue(value: unknown) {
	if (value instanceof Uint8Array) return { type: "blob" as const, encoding: "base64" as const, data: bytesToBase64(value) };
	if (value instanceof ArrayBuffer) return { type: "blob" as const, encoding: "base64" as const, data: bytesToBase64(new Uint8Array(value)) };
	return value as null | number | string;
}

export function decodeSqlValue(value: unknown): unknown {
	if (value && typeof value === "object" && (value as any).type === "blob") return base64ToBytes((value as any).data);
	return value;
}

export function bytesToBase64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

export function base64ToBytes(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
