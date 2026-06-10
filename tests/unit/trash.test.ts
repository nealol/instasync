import { describe, it, expect, vi } from "vitest";
import { VaultSync } from "../../src/VaultSync";
import { makeFakePlugin } from "../support/fakePlugin";

/**
 * The `plugindb` trash flow operates entirely on the local index doc, so it can
 * be exercised without a live y-sweet connection: we construct a VaultSync,
 * inject a fake `sqlApi`, and drive the trash methods directly.
 */
function makeSync() {
	const { plugin } = makeFakePlugin("http://127.0.0.1:1", {
		sessionToken: "t",
		activeVaultId: "vault-1",
	});

	const sqlApi = {
		live: false,
		restore: vi.fn(async () => {}),
		isLive: vi.fn(async () => sqlApi.live),
	};
	(plugin as any).sqlApi = sqlApi;

	const deletePluginDb = vi.fn(async () => {});
	(plugin.auth as any).deletePluginDb = deletePluginDb;

	const sync = new VaultSync(plugin as any);
	return { sync, sqlApi, deletePluginDb };
}

describe("plugin database trash integration", () => {
	it("records a plugindb trash entry and surfaces it in listTrash", () => {
		const { sync } = makeSync();
		try {
			sync.recordTrash({ path: "p/tasks", kind: "plugindb", pluginId: "p", name: "tasks" });
			const entries = sync.listTrash();
			const entry = entries.find((e) => e.kind === "plugindb");
			expect(entry).toBeTruthy();
			expect(entry!.path).toBe("p/tasks");
			expect(entry!.pluginId).toBe("p");
			expect(entry!.name).toBe("tasks");
		} finally {
			sync.destroy();
		}
	});

	it("restore clears the tombstone via sqlApi and removes the entry", async () => {
		const { sync, sqlApi } = makeSync();
		try {
			sync.recordTrash({ path: "p/tasks", kind: "plugindb", pluginId: "p", name: "tasks" });
			const id = sync.listTrash()[0].id;

			await sync.restoreTrashEntry(id);

			expect(sqlApi.isLive).toHaveBeenCalledWith({ pluginId: "p", name: "tasks" });
			expect(sqlApi.restore).toHaveBeenCalledWith({ pluginId: "p", name: "tasks" });
			expect(sync.listTrash().length).toBe(0);
		} finally {
			sync.destroy();
		}
	});

	it("restore rejects when a live DB with the same id already exists", async () => {
		const { sync, sqlApi } = makeSync();
		try {
			sqlApi.live = true;
			sync.recordTrash({ path: "p/tasks", kind: "plugindb", pluginId: "p", name: "tasks" });
			const id = sync.listTrash()[0].id;

			await expect(sync.restoreTrashEntry(id)).rejects.toThrow(/already active/);
			expect(sqlApi.restore).not.toHaveBeenCalled();
			// Entry remains in the trash for a later attempt.
			expect(sync.listTrash().length).toBe(1);
		} finally {
			sync.destroy();
		}
	});

	it("permanent delete purges the server replica and removes the entry", async () => {
		const { sync, deletePluginDb } = makeSync();
		try {
			sync.recordTrash({ path: "p/tasks", kind: "plugindb", pluginId: "p", name: "tasks" });
			const id = sync.listTrash()[0].id;

			await sync.permanentlyDeleteTrashEntry(id);

			expect(deletePluginDb).toHaveBeenCalledWith("vault-1", "p", "tasks");
			expect(sync.listTrash().length).toBe(0);
		} finally {
			sync.destroy();
		}
	});
});
