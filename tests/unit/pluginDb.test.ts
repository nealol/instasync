import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { encodeSqlValue, decodeSqlValue } from "../../src/pluginDb/crsqlite";
import { PluginDbSync, pluginDbDocId, pluginDbGuid, sanitizePluginDbId } from "../../src/pluginDb/PluginDbSync";
import type { SqlDatabaseAdapter } from "../../src/pluginDb/types";

class FakeDb implements SqlDatabaseAdapter {
	rows = new Map<string, any>();
	changes: any[] = [];
	siteId: string;
	closed = false;
	constructor(siteId: string) { this.siteId = siteId; }
	async exec(sql: string, params: unknown[] = []): Promise<void> {
		if (/CREATE TABLE/i.test(sql) || /crsql_as_crr/i.test(sql)) return;
		if (/INSERT INTO tasks/i.test(sql)) {
			const [id, title, done] = params;
			this.rows.set(String(id), { id, title, done });
			this.changes.push({ table: "tasks", pk: String(id), cid: "title", val: title, col_version: this.changes.length + 1, db_version: this.changes.length + 1, site_id: this.siteId, cl: 1, seq: this.changes.length + 1 });
			return;
		}
		if (/INSERT INTO crsql_changes/i.test(sql)) {
			const [table, pk, cid, val, col_version, db_version, site_id, cl, seq] = params as any[];
			if (table === "tasks" && cid === "title") this.rows.set(String(pk), { id: pk, title: val, done: 0 });
			this.changes.push({ table, pk, cid, val, col_version, db_version, site_id, cl, seq });
		}
	}
	async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
		if (/FROM crsql_changes/i.test(sql)) return this.changes.filter((c) => c.db_version > Number(params[0] ?? 0) && c.site_id === this.siteId) as T[];
		if (/crsql_site_id/i.test(sql)) return [{ site_id: this.siteId }] as T[];
		if (/crsql_master/i.test(sql)) return [{ value: 0 }] as T[];
		if (/FROM tasks/i.test(sql)) {
			for (const c of this.changes) if (c.table === "tasks" && c.cid === "title") this.rows.set(String(c.pk), { id: String(c.pk), title: c.val, done: 0 });
			return [...this.rows.values()] as T[];
		}
		return [];
	}
	async transaction<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
	async close(): Promise<void> { this.closed = true; }
}

describe("plugin DB ids", () => {
	it("sanitizes and builds deterministic doc ids", () => {
		expect(sanitizePluginDbId("my-plugin_1", "pluginId")).toBe("my-plugin_1");
		expect(() => sanitizePluginDbId("", "name")).toThrow();
		expect(() => sanitizePluginDbId("a/b", "name")).toThrow();
		expect(() => sanitizePluginDbId("a.b", "name")).toThrow();
		expect(() => sanitizePluginDbId("ü", "name")).toThrow();
		expect(pluginDbGuid("my-plugin", "main")).toBe("plugindb__my-plugin__main");
		expect(pluginDbDocId("vault", "my-plugin", "main")).toBe("vault__plugindb__my-plugin__main");
	});

	it("round-trips blob values as base64", () => {
		const encoded = encodeSqlValue(new Uint8Array([1, 2, 255]));
		expect(encoded).toEqual({ type: "blob", encoding: "base64", data: "AQL/" });
		expect([...decodeSqlValue(encoded) as Uint8Array]).toEqual([1, 2, 255]);
	});
});

describe("PluginDbSync", () => {
	it("syncs append-only batches between two fake clients and closes DBs", async () => {
		const ydoc = new Y.Doc();
		const dbA = new FakeDb("aa");
		const dbB = new FakeDb("bb");
		let opens = 0;
		const makePlugin = () => ({
			settings: { enabled: true, activeVaultId: "vault" },
			auth: { isLoggedIn: true, registerFile: async () => {} },
		}) as any;
		const deps = (db: FakeDb) => ({
			openSqliteDatabase: async () => { opens++; return db; },
			makeDoc: () => ({ ydoc, persistence: { whenSynced: Promise.resolve(), destroy: () => {} } }),
		});
		const a = new PluginDbSync(makePlugin(), deps(dbA));
		const b = new PluginDbSync(makePlugin(), deps(dbB));
		const opts = { pluginId: "my-plugin", name: "main", schema: async (db: any) => db.exec("CREATE TABLE tasks(id TEXT); SELECT crsql_as_crr('tasks')") };
		const aDb = await a.open(opts);
		const bDb = await b.open(opts);

		await aDb.exec("INSERT INTO tasks(id, title, done) VALUES (?, ?, ?)", ["t1", "Task", 0]);
		expect(ydoc.getArray("batches").length).toBeGreaterThan(0);
		await new Promise((r) => setTimeout(r, 400));
		await bDb.query("SELECT * FROM tasks");
		expect(dbB.changes.length).toBeGreaterThan(0);
		expect(dbB.changes[0]).toMatchObject({ table: "tasks", cid: "title" });

		expect(await bDb.query("SELECT * FROM tasks")).toEqual([{ id: "t1", title: "Task", done: 0 }]);
		expect(opens).toBe(2);
		a.destroy();
		b.destroy();
		await Promise.resolve();
		expect(dbA.closed).toBe(true);
		expect(dbB.closed).toBe(true);
	});
});
