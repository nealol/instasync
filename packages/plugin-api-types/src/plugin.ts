import type { RealtimeSql } from "./sql";
import type { RealtimeCursors } from "./cursors";

/**
 * The public API surface of the Realtime plugin, as exposed to other Obsidian
 * plugins. Access it through the plugin registry and cast:
 *
 * ```ts
 * import type { RealtimePluginApi } from "@realtime-md/plugin-api-types";
 *
 * const realtime = this.app.plugins.plugins["realtime"] as
 * 	| (Plugin & RealtimePluginApi)
 * 	| undefined;
 * if (!realtime) return; // Realtime not installed/enabled
 *
 * await realtime.sql.whenAvailable();
 * const db = await realtime.sql.open({ ... });
 * ```
 */
export interface RealtimePluginApi {
	/** Synced-SQLite databases. See {@link RealtimeSql}. */
	readonly sql: RealtimeSql;
	/** Plugin-managed remote cursors. See {@link RealtimeCursors}. */
	readonly cursors: RealtimeCursors;
}
