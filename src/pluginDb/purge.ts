export async function purgePersistedVaultState(vaultId: string): Promise<void> {
	if (!vaultId || typeof indexedDB === "undefined") return;
	const names = await listIndexedDbNames();
	await Promise.all(names.filter((name) => name === vaultId || name.startsWith(`${vaultId}__`)).map(deleteDb));
}

async function listIndexedDbNames(): Promise<string[]> {
	const anyIndexedDb = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
	if (typeof anyIndexedDb.databases === "function") {
		return (await anyIndexedDb.databases()).map((db) => db.name).filter((name): name is string => !!name);
	}
	return [];
}

function deleteDb(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error ?? new Error(`failed to delete IndexedDB ${name}`));
		req.onblocked = () => resolve();
	});
}
