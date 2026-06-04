import * as Y from "yjs";
import { YSweetProvider, STATUS_OFFLINE, STATUS_ERROR } from "@y-sweet/client";
import type { Awareness } from "y-protocols/awareness";
import { IndexeddbPersistence } from "y-indexeddb";
import { TFile, Notice, normalizePath } from "obsidian";
import type InstaSyncPlugin from "./main";
import { getClientToken } from "./ysweet";
import { applyTextToYText } from "./diff";

/**
 * Origin tag used on Yjs transactions that originate from this Document writing
 * disk content into the shared text, so our own ytext observer can ignore them.
 */
const DISK_ORIGIN = Symbol("instasync-disk");

/**
 * A single collaboratively-edited Markdown file. Owns its own Y.Doc and
 * y-sweet provider, and keeps the shared `contents` Y.Text in sync with the
 * file on disk when the file is not actively open in an editor.
 *
 * Offline durability: the Y.Doc is mirrored into IndexedDB via
 * {@link IndexeddbPersistence}. On startup we load that persisted state
 * (the "baseline" — the last state this device saw) *before* connecting, then
 * fold any local on-disk edits into the CRDT, then connect. This guarantees
 * offline edits become Yjs operations that merge with remote changes instead
 * of being clobbered.
 */
export class Document {
	readonly path: string;
	readonly guid: string;
	readonly ydoc: Y.Doc;
	readonly ytext: Y.Text;
	readonly provider: YSweetProvider;
	readonly awareness: Awareness;

	/** Number of CodeMirror editors currently bound to this document. */
	private boundEditors = 0;
	/** True while we are writing ytext content to disk (to ignore the echo). */
	private writingToDisk = false;
	private destroyed = false;

	/** Resolves once local state is loaded and the editor may safely bind. */
	private readyPromise: Promise<void>;
	private resolveReady!: () => void;

	/** Local persistence layer; gives us a baseline that survives restarts. */
	private persistence: IndexeddbPersistence;
	/** Disk content captured at startup, before remote sync (for conflict checks). */
	private diskAtStartup: string | null = null;
	/** Whether the local disk diverged from the baseline at startup. */
	private localChangedAtStartup = false;
	/** Guards the one-time startup merge so reconnects don't re-run it. */
	private startupReconciled = false;

	/** Whether this client created the index entry (and may seed an empty doc). */
	isCreator: boolean;

	private plugin: InstaSyncPlugin;
	private ytextObserver: () => void;
	private syncedListener: (synced: boolean) => void;
	private writeTimer: number | null = null;

	constructor(plugin: InstaSyncPlugin, path: string, guid: string, isCreator: boolean) {
		this.plugin = plugin;
		this.path = path;
		this.guid = guid;
		this.isCreator = isCreator;

		this.ydoc = new Y.Doc();
		this.ytext = this.ydoc.getText("contents");

		this.readyPromise = new Promise((resolve) => {
			this.resolveReady = resolve;
		});

		// Connect only after we have loaded the local baseline and folded in any
		// offline disk edits (see init()).
		this.provider = new YSweetProvider(
			() => getClientToken(plugin.settings.serverUrl, guid),
			guid,
			this.ydoc,
			{ connect: false, showDebuggerLink: false },
		);
		this.awareness = this.provider.awareness;
		this.persistence = new IndexeddbPersistence(guid, this.ydoc);

		// ytext changes (local edits from other peers, or our own editor) flow to
		// disk only while no editor is bound — otherwise Obsidian persists the file.
		this.ytextObserver = this.onYTextChanged.bind(this);
		this.ytext.observe(this.ytextObserver);

		// The provider re-fires "synced" on every (re)connection; the startup merge
		// runs only on the first one.
		this.syncedListener = (synced) => {
			if (synced) void this.finishStartupReconcile();
		};
		this.provider.on("synced", this.syncedListener);

		void this.init();
	}

	whenReady(): Promise<void> {
		return this.readyPromise;
	}

	get content(): string {
		return this.ytext.toString();
	}

	bindEditor(): void {
		this.boundEditors++;
	}

	unbindEditor(): void {
		this.boundEditors = Math.max(0, this.boundEditors - 1);
		// When the last editor closes, make sure disk reflects the shared state.
		if (this.boundEditors === 0 && !this.destroyed) {
			void this.writeToDisk(this.content);
		}
	}

	get hasBoundEditor(): boolean {
		return this.boundEditors > 0;
	}

	/** Nudge a stalled provider to reconnect. Safe to call repeatedly. */
	ensureConnected(): void {
		if (this.destroyed) return;
		const status = this.provider.status;
		if (status === STATUS_OFFLINE || status === STATUS_ERROR) {
			void this.provider.connect();
		}
	}

	/**
	 * Startup sequence: load the persisted baseline, fold local offline disk edits
	 * into the CRDT, then connect. Resolves {@link readyPromise} once the local
	 * state is ready so editors can bind even while offline.
	 */
	private async init(): Promise<void> {
		try {
			await this.persistence.whenSynced;
			if (this.destroyed) return;

			const baseline = this.content;
			const disk = await this.readFromDisk();
			this.diskAtStartup = disk;
			this.localChangedAtStartup = disk !== null && disk !== baseline;

			if (this.localChangedAtStartup && disk !== null) {
				// Fold the local on-disk version into the CRDT as local operations,
				// so it merges with whatever the server has rather than overwriting it.
				this.ydoc.transact(() => {
					applyTextToYText(this.ytext, disk, DISK_ORIGIN);
				}, DISK_ORIGIN);
			}
		} catch (e) {
			console.error(`[InstaSync] init failed for ${this.path}`, e);
		} finally {
			// Editors may bind now: ytext holds (baseline + local offline edits).
			this.resolveReady();
		}

		if (!this.destroyed) void this.provider.connect();
	}

	/**
	 * Runs once, after the first successful server sync. The CRDT now holds the
	 * merge of our local offline edits and any concurrent remote edits.
	 *  - pure remote update            -> write the merged text to disk;
	 *  - local-only fast-forward       -> write (a no-op in practice);
	 *  - both sides changed (conflict) -> save the local pre-merge copy aside,
	 *                                     write the merged text, and notify.
	 */
	private async finishStartupReconcile(): Promise<void> {
		if (this.startupReconciled || this.destroyed) return;
		this.startupReconciled = true;

		try {
			const merged = this.content;
			const localDisk = this.diskAtStartup;

			const isConflict =
				this.localChangedAtStartup && localDisk !== null && merged !== localDisk;

			if (isConflict) {
				await this.writeConflictCopy(localDisk);
			}

			// The editor (if bound) already received the merged text via the ytext
			// observer and Obsidian persists it; only write to disk ourselves when
			// no editor owns the file.
			if (!this.hasBoundEditor) {
				await this.writeToDisk(merged);
			}
		} catch (e) {
			console.error(`[InstaSync] startup reconcile failed for ${this.path}`, e);
		}
	}

	/**
	 * Saves the user's pre-merge local version next to the file so nothing is lost
	 * when a CRDT auto-merge interleaves concurrent edits. The copy is named so
	 * that {@link VaultSync} recognises and skips it (it must not sync itself).
	 */
	private async writeConflictCopy(localContent: string): Promise<void> {
		const conflictPath = this.conflictCopyPath();
		try {
			await this.ensureParentFolder(conflictPath);
			await this.plugin.app.vault.create(conflictPath, localContent);
			new Notice(
				`InstaSync: "${this.path}" was edited in two places. ` +
					`Merged remote changes in; your local copy was saved as "${conflictPath}".`,
				10000,
			);
		} catch (e) {
			console.error(`[InstaSync] failed to write conflict copy for ${this.path}`, e);
		}
	}

	private conflictCopyPath(): string {
		const name = this.plugin.settings.clientName || "local";
		const stamp = formatTimestamp(new Date());
		const dot = this.path.lastIndexOf(".");
		const hasExt = dot > this.path.lastIndexOf("/");
		const base = hasExt ? this.path.slice(0, dot) : this.path;
		const ext = hasExt ? this.path.slice(dot) : ".md";
		return normalizePath(`${base} (conflicted copy ${name} ${stamp})${ext}`);
	}

	private onYTextChanged(): void {
		if (this.destroyed) return;
		// While an editor is bound, the editor reflects the change and Obsidian
		// writes the file; doing it here too would race.
		if (this.hasBoundEditor) return;
		this.scheduleWriteToDisk();
	}

	private scheduleWriteToDisk(): void {
		if (this.writeTimer !== null) {
			window.clearTimeout(this.writeTimer);
		}
		this.writeTimer = window.setTimeout(() => {
			this.writeTimer = null;
			void this.writeToDisk(this.content);
		}, 100);
	}

	/** Called by VaultSync when the local file changed and no editor is bound. */
	async onDiskChanged(): Promise<void> {
		if (this.destroyed || this.writingToDisk || this.hasBoundEditor) return;
		const disk = await this.readFromDisk();
		if (disk === null) return;
		if (disk === this.content) return;
		this.ydoc.transact(() => {
			applyTextToYText(this.ytext, disk, DISK_ORIGIN);
		}, DISK_ORIGIN);
	}

	private getFile(): TFile | null {
		const af = this.plugin.app.vault.getAbstractFileByPath(this.path);
		return af instanceof TFile ? af : null;
	}

	private async readFromDisk(): Promise<string | null> {
		const file = this.getFile();
		if (!file) return null;
		return await this.plugin.app.vault.read(file);
	}

	private async writeToDisk(text: string): Promise<void> {
		if (this.destroyed) return;
		this.writingToDisk = true;
		try {
			const file = this.getFile();
			if (file) {
				if ((await this.plugin.app.vault.read(file)) === text) return;
				await this.plugin.app.vault.modify(file, text);
			} else {
				// Remote-created file that does not exist locally yet.
				const path = normalizePath(this.path);
				await this.ensureParentFolder(path);
				await this.plugin.app.vault.create(path, text);
			}
		} catch (e) {
			console.error(`[InstaSync] writeToDisk failed for ${this.path}`, e);
		} finally {
			// Release on the next tick so the resulting vault 'modify' event,
			// which is dispatched asynchronously, is still treated as our own.
			window.setTimeout(() => {
				this.writingToDisk = false;
			}, 0);
		}
	}

	private async ensureParentFolder(path: string): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash <= 0) return;
		const folder = path.slice(0, slash);
		if (!this.plugin.app.vault.getAbstractFileByPath(folder)) {
			try {
				await this.plugin.app.vault.createFolder(folder);
			} catch (e) {
				// Folder may have been created concurrently; ignore.
			}
		}
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		if (this.writeTimer !== null) {
			window.clearTimeout(this.writeTimer);
			this.writeTimer = null;
		}
		this.ytext.unobserve(this.ytextObserver);
		this.provider.off("synced", this.syncedListener);
		this.provider.destroy();
		void this.persistence.destroy();
		this.ydoc.destroy();
	}
}

/** Formats a date as `YYYY-MM-DD HHmmss` (no colons — safe in filenames). */
function formatTimestamp(d: Date): string {
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return (
		`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
		`${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	);
}
