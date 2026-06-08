import { describe, expect, it } from "vitest";
import { indexedDB } from "fake-indexeddb";
import { purgePersistedVaultState } from "../../src/pluginDb/purge";

function openDb(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(name);
		req.onsuccess = () => { req.result.close(); resolve(); };
		req.onerror = () => reject(req.error);
	});
}

describe("purgePersistedVaultState", () => {
	it("deletes vault index and namespaced docs only", async () => {
		(globalThis as any).indexedDB = indexedDB;
		await openDb("vault");
		await openDb("vault__doc");
		await openDb("other__doc");
		await purgePersistedVaultState("vault");
		const names = (await indexedDB.databases()).map((db) => db.name);
		expect(names).not.toContain("vault");
		expect(names).not.toContain("vault__doc");
		expect(names).toContain("other__doc");
	});
});
