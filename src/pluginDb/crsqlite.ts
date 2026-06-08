import initWasm from "@vlcn.io/crsqlite-wasm";
import { requestUrl } from "obsidian";
import type { SqlDatabaseAdapter } from "./types";

declare const __dirname: string | undefined;
declare const require: ((id: string) => unknown) | undefined;

let sqlitePromise: ReturnType<typeof initWasm> | null = null;
let fallbackWasmUrl = "";
let localWasmPath = "";
let resolvedWasmUrl = "";
let indexedDbTransactionShimInstalled = false;

export function configureCrsqliteWasmFallback(url: string, localPath?: string): void {
	fallbackWasmUrl = url;
	localWasmPath = localPath?.replace(/\\/g, "/") ?? "";
	resolvedWasmUrl = "";
}

function wasmUrl(file: string): string {
	if (file !== "crsqlite.wasm") return file;
	if (resolvedWasmUrl) return resolvedWasmUrl;
	if (localWasmPath) return localWasmPath;
	if (typeof __dirname === "string") {
		const localPath = `${__dirname.replace(/\\/g, "/")}/crsqlite.wasm`;
		return localPath;
	}
	if (fallbackWasmUrl) return fallbackWasmUrl;
	return "crsqlite.wasm";
}

function localFileExists(path: string): boolean {
	try {
		if (typeof require !== "function") return false;
		const fs = require("fs") as { existsSync?: (path: string) => boolean };
		return fs.existsSync?.(path) === true;
	} catch {
		return false;
	}
}

function readLocalFile(path: string): Uint8Array | null {
	try {
		if (typeof require !== "function") return null;
		const fs = require("fs") as { readFileSync?: (path: string) => Uint8Array };
		return fs.readFileSync?.(path) ?? null;
	} catch {
		return null;
	}
}

function blobUrl(bytes: Uint8Array): string {
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	return URL.createObjectURL(new Blob([buffer], { type: "application/wasm" }));
}

async function ensureLocalWasm(): Promise<void> {
	const localPath = localWasmPath || (typeof __dirname === "string" ? `${__dirname.replace(/\\/g, "/")}/crsqlite.wasm` : "");
	if (localPath && localFileExists(localPath)) {
		const bytes = readLocalFile(localPath);
		resolvedWasmUrl = bytes ? blobUrl(bytes) : localPath;
		return;
	}
	if (!fallbackWasmUrl) {
		resolvedWasmUrl = localPath || "crsqlite.wasm";
		return;
	}
	if (!localPath) {
		resolvedWasmUrl = fallbackWasmUrl;
		return;
	}
	console.warn(`[Realtime] crsqlite.wasm not found at ${localPath}; downloading release asset.`);
	const res = await requestUrl({ url: fallbackWasmUrl, throw: false });
	if (res.status < 200 || res.status >= 300) throw new Error(`failed to download crsqlite.wasm: HTTP ${res.status}`);
	const bytes = new Uint8Array(res.arrayBuffer);
	try {
		if (typeof require !== "function") throw new Error("filesystem unavailable");
		const fs = require("fs") as { writeFileSync?: (path: string, data: Uint8Array) => void };
		if (!fs.writeFileSync) throw new Error("filesystem unavailable");
		fs.writeFileSync(localPath, bytes);
		resolvedWasmUrl = blobUrl(bytes);
	} catch (e) {
		console.warn(`[Realtime] failed to cache crsqlite.wasm locally; using downloaded bytes: ${e instanceof Error ? e.message : String(e)}`);
		resolvedWasmUrl = blobUrl(bytes);
	}
}

export async function openCrsqliteDatabase(name: string): Promise<SqlDatabaseAdapter> {
	if (!sqlitePromise) sqlitePromise = ensureLocalWasm().then(() => {
		installIndexedDbTransactionOptionsShim();
		return initWasm(wasmUrl);
	});
	const sqlite = await sqlitePromise;
	const filename = sqliteFilename(name);
	let db: Awaited<ReturnType<typeof sqlite.open>>;
	try {
		db = await sqlite.open(filename);
	} catch (e) {
		if (name !== ":memory:") {
			console.warn(`[Realtime] persistent crsqlite database failed to open; falling back to memory: ${openErrorMessage(filename, e)}`);
			db = await sqlite.open();
		} else {
			throw new Error(openErrorMessage(filename, e));
		}
	}
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

function openErrorMessage(filename: string, e: unknown): string {
	const cause = e instanceof Error ? e.message : String(e);
	const errorName = e instanceof Error ? e.name : typeof e;
	const hasIndexedDb = typeof indexedDB !== "undefined";
	const hasWebLocks = typeof navigator !== "undefined" && "locks" in navigator;
	return `failed to open crsqlite database ${filename}: ${errorName}: ${cause} (indexedDB=${hasIndexedDb}, webLocks=${hasWebLocks})`;
}

function sqliteFilename(name: string): string {
	if (name === ":memory:" || name.startsWith("file:")) return name;
	return `file:/realtime/plugin-dbs/${encodeURIComponent(name)}`;
}

function installIndexedDbTransactionOptionsShim(): void {
	if (indexedDbTransactionShimInstalled) return;
	indexedDbTransactionShimInstalled = true;
	const proto = (globalThis as any).IDBDatabase?.prototype as { transaction?: (...args: any[]) => IDBTransaction } | undefined;
	if (!proto?.transaction) return;
	const transaction = proto.transaction;
	proto.transaction = function(this: IDBDatabase, storeNames: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
		try {
			return transaction.call(this, storeNames, mode, options);
		} catch (e) {
			if (options === undefined) throw e;
			return transaction.call(this, storeNames, mode);
		}
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
