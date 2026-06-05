import * as Y from "yjs";
import { TFile, Notice } from "obsidian";
import type InstaSyncPlugin from "./main";
import type { VaultSync } from "./VaultSync";
import { sha256Hex } from "./hash";
import { dbg } from "./debug";
import { ensureParentFolder, getFileByPath, isOpenInWorkspace } from "./vaultHelpers";
import { openBinaryConflictModal, type ConflictChoice } from "./BinaryConflictModal";

/**
 * Upload-queue state surfaced to the status bar:
 *  - `uploading` — a blob transfer is in flight;
 *  - `pending`   — blobs are queued but deferred (e.g. a large file waiting for
 *                  note sync to quiet down);
 *  - `idle`      — nothing queued or in flight.
 */
export type UploadStatus = "idle" | "uploading" | "pending";

/** Metadata tracked per binary file in the shared index doc. */
export interface BinaryMeta {
	/** Lowercase hex sha256 of the file's bytes — the blob store key. */
	hash: string;
	/** Byte length, for display and upload scheduling. */
	size: number;
}

/** Files at or above this size are uploaded in the background, deferred while
 *  notes are actively syncing, so a large attachment can't stall note sync. */
const LARGE_FILE_BYTES = 5 * 1024 * 1024;
/** Max upload attempts before giving up (with a Notice). */
const MAX_UPLOAD_ATTEMPTS = 5;
/** Delay before re-draining the upload queue when deferred / after a failure. */
const DRAIN_RETRY_MS = 2000;

interface UploadJob {
	path: string;
	hash: string;
	bytes: ArrayBuffer;
	size: number;
	attempts: number;
}

/**
 * Syncs binary (non-Markdown) files via a content-addressed blob store instead of
 * the text CRDT. Only a `path -> { hash, size }` mapping travels through the shared
 * index Y.Doc (the `binaries` map); the bytes live on the server, keyed by hash.
 *
 * Reconciliation is a single idempotent {@link reconcile} per path, driven from
 * three sources — local vault events, remote `binaries` map changes, and the
 * one-shot startup pass — comparing three hashes: the local disk, the remote map
 * entry, and {@link lastSyncedHash} (what this device last agreed on). When both
 * the local and remote sides moved off that baseline, it's a true conflict and we
 * ask the user (keep local / keep remote). Map entries are published only *after*
 * the blob upload succeeds, so peers never see a hash whose bytes aren't on the
 * server yet.
 */
export class BinarySync {
	private plugin: InstaSyncPlugin;
	private vaultSync: VaultSync;
	private binaries: Y.Map<BinaryMeta>;
	private indexDoc: Y.Doc;

	/** Per-path hash this device has reconciled with disk (the merge baseline). */
	private lastSyncedHash = new Map<string, string>();
	/** Serializes reconcile() per path so concurrent triggers can't interleave. */
	private chains = new Map<string, Promise<void>>();
	/** Paths we are currently writing to disk, to ignore the resulting vault event. */
	private writing = new Set<string>();

	/** Background upload queue (latest job per path wins). */
	private uploadQueue: UploadJob[] = [];
	private draining = false;
	/** True only while a single blob transfer is actually in flight. */
	private activeUpload = false;
	private drainTimer: number | null = null;
	/** Last reported upload status (for the status bar); only emit on change. */
	private uploadStatus: UploadStatus = "idle";

	/** Serializes conflict modals so only one is shown at a time. */
	private conflictChain: Promise<void> = Promise.resolve();

	/** Observer is a no-op until the startup pass runs (see {@link reconcileAll}). */
	private started = false;
	private destroyed = false;
	private observer: (event: Y.YMapEvent<BinaryMeta>) => void;

	constructor(plugin: InstaSyncPlugin, vaultSync: VaultSync, indexDoc: Y.Doc) {
		this.plugin = plugin;
		this.vaultSync = vaultSync;
		this.indexDoc = indexDoc;
		this.binaries = indexDoc.getMap<BinaryMeta>("binaries");
		this.observer = this.onBinariesChanged.bind(this);
		this.binaries.observe(this.observer);
	}

	private get vaultId(): string {
		return this.plugin.settings.activeVaultId;
	}

	// --- startup ---------------------------------------------------------------

	/**
	 * Capture the persisted (pre-remote-merge) map as the sync baseline. Must run
	 * after the index persistence loads but *before* the provider connects, so we
	 * record what this device last agreed on rather than the merged result.
	 */
	seedBaseline(): void {
		for (const [path, meta] of this.binaries.entries()) {
			if (meta?.hash) this.lastSyncedHash.set(path, meta.hash);
		}
		dbg("BinarySync seedBaseline", this.lastSyncedHash.size, "entries");
	}

	/**
	 * One-shot reconcile after the first server sync: walk every path known to the
	 * remote map or present locally, then enable the live observer.
	 */
	async reconcileAll(localBinaryPaths: string[]): Promise<void> {
		if (this.destroyed) return;
		this.started = true;

		const paths = new Set<string>(this.binaries.keys());
		for (const p of localBinaryPaths) paths.add(p);

		for (const path of paths) {
			await this.reconcile(path);
			if (this.destroyed) return;
		}
	}

	// --- live triggers ---------------------------------------------------------

	/** A local binary file was created or modified. */
	onLocalChanged(path: string): void {
		if (this.writing.has(path)) return;
		void this.reconcile(path);
	}

	/** A local binary file was deleted. */
	onLocalDeleted(path: string): void {
		if (this.writing.has(path)) return;
		void this.reconcile(path);
	}

	/** A local binary file was renamed: treat as a delete of old + change of new. */
	onLocalRenamed(file: TFile, oldPath: string): void {
		void this.reconcile(oldPath);
		void this.reconcile(file.path);
	}

	private onBinariesChanged(event: Y.YMapEvent<BinaryMeta>): void {
		if (this.destroyed || !this.started) return;
		event.changes.keys.forEach((_change, path) => {
			void this.reconcile(path);
		});
	}

	// --- core reconcile --------------------------------------------------------

	/** Run `fn` exclusively for `path`, chaining after any in-flight reconcile. */
	private reconcile(path: string): Promise<void> {
		const prev = this.chains.get(path) ?? Promise.resolve();
		const next = prev.then(() => this.reconcileNow(path)).catch((e) => {
			console.error(`[InstaSync] binary reconcile failed for ${path}`, e);
		});
		this.chains.set(path, next);
		void next.finally(() => {
			if (this.chains.get(path) === next) this.chains.delete(path);
		});
		return next;
	}

	private async reconcileNow(path: string): Promise<void> {
		if (this.destroyed) return;

		const localHash = await this.hashDisk(path);
		if (this.destroyed) return;
		const remote = this.binaries.get(path);
		const remoteHash = remote?.hash ?? null;
		const base = this.lastSyncedHash.get(path) ?? null;

		// Already in agreement (both sides equal, or both absent).
		if (localHash === remoteHash) {
			if (remoteHash) this.lastSyncedHash.set(path, remoteHash);
			else this.lastSyncedHash.delete(path);
			return;
		}

		if (localHash === undefined) {
			// Could not read the local file. Do not treat that as a delete.
			return;
		}

		// Local present, remote absent.
		if (localHash && !remoteHash) {
			if (base === null) {
				// Brand-new local file → publish it.
				await this.queueLocalUpload(path);
			} else if (base === localHash) {
				// Cleanly deleted remotely and we have no unsynced local changes →
				// the remote delete is authoritative, so remove the local copy.
				await this.deleteLocal(path);
			} else {
				// Deleted remotely but we also have unsynced local edits → conflict.
				await this.resolveConflict(path, localHash, null);
			}
			return;
		}

		// Local absent, remote present.
		if (!localHash && remoteHash) {
			if (base === remoteHash) {
				// We deleted it locally → propagate the delete to the index.
				this.publishDelete(path);
			} else {
				// New remote file, or remote moved while we had no local copy → pull.
				await this.downloadToDisk(path, remoteHash);
			}
			return;
		}

		// Both present and different.
		if (localHash && remoteHash && localHash !== remoteHash) {
			if (base === remoteHash) {
				// Clean local edit: remote hasn't moved since our baseline.
				await this.queueLocalUpload(path);
			} else if (base === localHash) {
				// Clean remote update: local matches baseline, remote moved.
				await this.downloadToDisk(path, remoteHash);
			} else {
				// Both diverged from the baseline (or no baseline) → conflict.
				await this.resolveConflict(path, localHash, remoteHash);
			}
		}
	}

	// --- disk I/O --------------------------------------------------------------

	private async hashDisk(path: string): Promise<string | null | undefined> {
		const file = getFileByPath(this.plugin.app, path);
		if (!file) return null;
		try {
			const buf = await this.plugin.app.vault.readBinary(file);
			return await sha256Hex(buf);
		} catch (e) {
			console.error(`[InstaSync] failed to read binary ${path}`, e);
			return undefined;
		}
	}

	private async readDisk(path: string): Promise<ArrayBuffer | null> {
		const file = getFileByPath(this.plugin.app, path);
		if (!file) return null;
		return await this.plugin.app.vault.readBinary(file);
	}

	private async downloadToDisk(path: string, hash: string): Promise<void> {
		if (isOpenInWorkspace(this.plugin.app, path)) {
			// Don't overwrite a file the user is viewing; retry shortly.
			dbg("binary download deferred (open)", path);
			window.setTimeout(() => void this.reconcile(path), DRAIN_RETRY_MS);
			return;
		}
		let bytes: ArrayBuffer;
		try {
			bytes = await this.plugin.auth.getBlob(this.vaultId, hash);
		} catch (e) {
			if (this.destroyed) return;
			console.error(`[InstaSync] blob download failed for ${path}`, e);
			window.setTimeout(() => void this.reconcile(path), DRAIN_RETRY_MS);
			return;
		}
		if (this.destroyed) return;
		await this.writeDisk(path, bytes);
		if (this.destroyed) return;
		this.lastSyncedHash.set(path, hash);
		dbg("binary downloaded", path, hash, bytes.byteLength);
	}

	private async writeDisk(path: string, bytes: ArrayBuffer): Promise<void> {
		if (this.destroyed) return;
		this.writing.add(path);
		try {
			const file = getFileByPath(this.plugin.app, path);
			if (file) {
				if (isOpenInWorkspace(this.plugin.app, path)) return;
				await this.plugin.app.vault.modifyBinary(file, bytes);
			} else {
				await ensureParentFolder(this.plugin.app, path);
				await this.plugin.app.vault.createBinary(path, bytes);
			}
		} catch (e) {
			console.error(`[InstaSync] writeDisk failed for ${path}`, e);
		} finally {
			// Release on the next tick so the resulting vault event is still ours.
			window.setTimeout(() => this.writing.delete(path), 0);
		}
	}

	private async deleteLocal(path: string): Promise<void> {
		if (this.destroyed) return;
		const file = getFileByPath(this.plugin.app, path);
		if (!file) {
			this.lastSyncedHash.delete(path);
			return;
		}
		this.writing.add(path);
		try {
			await this.plugin.app.vault.delete(file);
			this.lastSyncedHash.delete(path);
		} catch (e) {
			console.error(`[InstaSync] failed to delete binary ${path}`, e);
		} finally {
			window.setTimeout(() => this.writing.delete(path), 0);
		}
	}

	// --- index mutations -------------------------------------------------------

	private publishMeta(path: string, meta: BinaryMeta): void {
		this.indexDoc.transact(() => {
			this.binaries.set(path, meta);
		});
		this.lastSyncedHash.set(path, meta.hash);
	}

	private publishDelete(path: string): void {
		this.indexDoc.transact(() => {
			this.binaries.delete(path);
		});
		this.lastSyncedHash.delete(path);
	}

	// --- upload queue ----------------------------------------------------------

	/** Read the current local bytes for `path` and enqueue them for upload. */
	private async queueLocalUpload(path: string): Promise<void> {
		const bytes = await this.readDisk(path);
		if (this.destroyed) return;
		if (!bytes) return;
		const hash = await sha256Hex(bytes);
		if (this.destroyed) return;
		this.enqueueUpload({ path, hash, bytes, size: bytes.byteLength, attempts: 0 });
	}

	private enqueueUpload(job: UploadJob): void {
		// Latest job per path wins.
		this.uploadQueue = this.uploadQueue.filter((j) => j.path !== job.path);
		this.uploadQueue.push(job);
		this.refreshUploadStatus();
		this.scheduleDrain();
	}

	/** Notify the plugin when the upload status (idle/pending/uploading) changes. */
	private refreshUploadStatus(): void {
		let status: UploadStatus;
		if (this.destroyed) status = "idle";
		else if (this.activeUpload) status = "uploading";
		else if (this.uploadQueue.length > 0) status = "pending";
		else status = "idle";
		if (status === this.uploadStatus) return;
		this.uploadStatus = status;
		this.plugin.setUploadStatus(status);
	}

	private scheduleDrain(delay = 0): void {
		if (this.drainTimer !== null) return;
		this.drainTimer = window.setTimeout(() => {
			this.drainTimer = null;
			void this.drain();
		}, delay);
	}

	private async drain(): Promise<void> {
		if (this.draining || this.destroyed) return;
		this.draining = true;
		this.refreshUploadStatus();
		try {
			while (this.uploadQueue.length && !this.destroyed) {
				const job = this.uploadQueue[0];
				// Hold large transfers back while notes are actively syncing — they
				// stay queued and surface as "pending" rather than "uploading".
				if (job.size >= LARGE_FILE_BYTES && this.vaultSync.isTextSyncBusy()) {
					this.scheduleDrain(DRAIN_RETRY_MS);
					break;
				}
				this.uploadQueue.shift();
				this.activeUpload = true;
				this.refreshUploadStatus();
				try {
					await this.doUpload(job);
				} catch (e) {
					job.attempts++;
					if (job.attempts < MAX_UPLOAD_ATTEMPTS) {
						this.uploadQueue.push(job);
						this.scheduleDrain(DRAIN_RETRY_MS);
					} else {
						console.error(`[InstaSync] giving up uploading ${job.path}`, e);
						new Notice(`InstaSync: failed to upload "${job.path}".`);
					}
					break;
				} finally {
					this.activeUpload = false;
					this.refreshUploadStatus();
				}
			}
		} finally {
			this.draining = false;
			this.refreshUploadStatus();
		}
	}

	private async doUpload(job: UploadJob): Promise<void> {
		const exists = await this.plugin.auth.blobExists(this.vaultId, job.hash);
		if (this.destroyed) return;
		if (!exists) {
			await this.plugin.auth.putBlob(this.vaultId, job.hash, job.bytes);
		}
		if (this.destroyed) return;
		// Publish only now that the bytes are on the server.
		this.publishMeta(job.path, { hash: job.hash, size: job.size });
		dbg("binary uploaded+published", job.path, job.hash, job.size);
	}

	// --- conflicts -------------------------------------------------------------

	/**
	 * Queue a keep-local / keep-remote modal (serialized). `localHash` is the
	 * current disk hash; `remoteHash` is null when the remote side deleted the file.
	 */
	private resolveConflict(
		path: string,
		localHash: string,
		remoteHash: string | null,
	): Promise<void> {
		const run = this.conflictChain.then(async () => {
			if (this.destroyed) return;
			// Re-check state at prompt time — it may have converged while queued.
			const nowLocal = await this.hashDisk(path);
			if (nowLocal === undefined) return;
			const nowRemote = this.binaries.get(path)?.hash ?? null;
			if (nowLocal === nowRemote) {
				if (nowRemote) this.lastSyncedHash.set(path, nowRemote);
				return;
			}
			const choice = await openBinaryConflictModal(this.plugin, {
				path,
				remoteDeleted: nowRemote === null,
			});
			await this.applyConflictChoice(path, choice, nowLocal, nowRemote);
		});
		this.conflictChain = run.catch((e) => {
			console.error(`[InstaSync] conflict resolution failed for ${path}`, e);
		});
		return this.conflictChain;
	}

	private async applyConflictChoice(
		path: string,
		choice: ConflictChoice,
		localHash: string | null,
		remoteHash: string | null,
	): Promise<void> {
		if (choice === "local") {
			if (remoteHash === null && localHash) {
				// Remote deleted, user keeps local → republish it.
				await this.queueLocalUpload(path);
			} else if (localHash) {
				await this.queueLocalUpload(path);
			}
			new Notice(`InstaSync: kept your local copy of "${path}".`);
		} else {
			if (remoteHash === null) {
				// Remote deleted, user keeps remote → delete local.
				await this.deleteLocal(path);
			} else {
				await this.downloadToDisk(path, remoteHash);
			}
			new Notice(`InstaSync: replaced "${path}" with the remote copy.`);
		}
	}

	// --- lifecycle -------------------------------------------------------------

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.binaries.unobserve(this.observer);
		if (this.drainTimer !== null) {
			window.clearTimeout(this.drainTimer);
			this.drainTimer = null;
		}
		this.uploadQueue = [];
		this.chains.clear();
		this.refreshUploadStatus();
	}
}
