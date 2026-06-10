/**
 * The Yjs view of a single synced plugin database.
 *
 * Owns the three shared structures inside the per-DB Y.Doc and exposes typed
 * accessors. It does not touch cr-sqlite or the network — the caller injects an
 * already-built {@link PluginDbDocHandle} (a Y.Doc plus, in production, a
 * y-sweet provider + IndexedDB persistence) so the engine is testable with a
 * bare in-memory doc.
 *
 * Doc layout:
 *  - `batches: Y.Array<Batch>`              — append-only change log (trimmed by the server)
 *  - `cursors: Y.Map<siteHex, Cursor>`      — each device's applied-remote cursor
 *  - `cursorsAt: Y.Map<siteHex, number>`    — when each device last refreshed its cursor
 *    (lets the server's compaction ignore devices gone for > the staleness window)
 *  - `meta:    Y.Map<…>`                    — format, schemaVersion, compactedThrough, deletedAt
 */

import * as Y from "yjs";
import type { Batch, Cursor } from "./types";
import { SYNC_FORMAT } from "./types";

export interface PluginDbDocHandle {
	doc: Y.Doc;
	/** Resolves once persisted/initial state has loaded. */
	whenSynced: Promise<void>;
	/** True while the live transport is connected (always true for bare docs). */
	isConnected(): boolean;
	/** Subscribe to connection status edges; returns an unsubscribe. */
	onStatus(cb: (connected: boolean) => void): () => void;
	/**
	 * Resolves once pending local updates have been sent to the server (or after
	 * a short timeout when offline). Call before destroy() so a final write —
	 * e.g. the delete tombstone — is not dropped with the connection.
	 */
	whenFlushed?(): Promise<void>;
	destroy(): void;
}

export class PluginDbSync {
	readonly doc: Y.Doc;
	private handle: PluginDbDocHandle;
	private batches: Y.Array<Batch>;
	private cursors: Y.Map<Cursor>;
	private cursorsAt: Y.Map<number>;
	private meta: Y.Map<unknown>;

	constructor(handle: PluginDbDocHandle) {
		this.handle = handle;
		this.doc = handle.doc;
		this.batches = this.doc.getArray<Batch>("batches");
		this.cursors = this.doc.getMap<Cursor>("cursors");
		this.cursorsAt = this.doc.getMap<number>("cursorsAt");
		this.meta = this.doc.getMap<unknown>("meta");
	}

	whenSynced(): Promise<void> {
		return this.handle.whenSynced;
	}

	isConnected(): boolean {
		return this.handle.isConnected();
	}

	onStatus(cb: (connected: boolean) => void): () => void {
		return this.handle.onStatus(cb);
	}

	// --- batches ---------------------------------------------------------------

	listBatches(): Batch[] {
		return this.batches.toArray();
	}

	appendBatch(batch: Batch): void {
		this.doc.transact(() => {
			this.batches.push([batch]);
			const current = (this.meta.get("schemaVersion") as number | undefined) ?? 0;
			if (batch.schemaVersion > current) this.meta.set("schemaVersion", batch.schemaVersion);
			if (!this.meta.get("format")) this.meta.set("format", SYNC_FORMAT);
		});
	}

	observeBatches(cb: (batches: Batch[]) => void): () => void {
		const observer = () => cb(this.batches.toArray());
		this.batches.observe(observer);
		return () => this.batches.unobserve(observer);
	}

	// --- cursors ---------------------------------------------------------------

	/** This device's applied-remote cursor (keyed by the device's own site id). */
	getCursor(deviceSiteHex: string): Cursor {
		return { ...(this.cursors.get(deviceSiteHex) ?? {}) };
	}

	setCursor(deviceSiteHex: string, cursor: Cursor): void {
		this.doc.transact(() => {
			this.cursors.set(deviceSiteHex, { ...cursor });
			this.cursorsAt.set(deviceSiteHex, Date.now());
		});
	}

	/** Every device's cursor, used by the server's compaction safety check. */
	allCursors(): Record<string, Cursor> {
		const out: Record<string, Cursor> = {};
		for (const [site, cursor] of this.cursors.entries()) out[site] = { ...cursor };
		return out;
	}

	// --- meta ------------------------------------------------------------------

	getSchemaVersion(): number {
		return (this.meta.get("schemaVersion") as number | undefined) ?? 0;
	}

	/** The CRR schema DDL, published so the server can build a replica + git dump. */
	getSchema(): string[] {
		const v = this.meta.get("schema");
		return Array.isArray(v) ? (v as string[]) : [];
	}

	setSchema(ddl: string[], schemaVersion: number): void {
		const current = this.getSchema();
		if (current.length === ddl.length && current.every((s, i) => s === ddl[i])) {
			// Still make sure the version is recorded.
			if (this.getSchemaVersion() < schemaVersion) {
				this.doc.transact(() => this.meta.set("schemaVersion", schemaVersion));
			}
			return;
		}
		this.doc.transact(() => {
			this.meta.set("schema", ddl);
			if (this.getSchemaVersion() < schemaVersion) this.meta.set("schemaVersion", schemaVersion);
		});
	}

	getCompactedThrough(): Cursor {
		return { ...((this.meta.get("compactedThrough") as Cursor | undefined) ?? {}) };
	}

	getDeletedAt(): number | null {
		const v = this.meta.get("deletedAt");
		return typeof v === "number" ? v : null;
	}

	setDeletedAt(ms: number): void {
		this.doc.transact(() => this.meta.set("deletedAt", ms));
	}

	clearDeletedAt(): void {
		this.doc.transact(() => this.meta.delete("deletedAt"));
	}

	observeMeta(cb: () => void): () => void {
		const observer = () => cb();
		this.meta.observe(observer);
		return () => this.meta.unobserve(observer);
	}

	/** Wait for pending local updates to reach the server (best effort). */
	async whenFlushed(): Promise<void> {
		await this.handle.whenFlushed?.();
	}

	destroy(): void {
		this.handle.destroy();
	}
}
