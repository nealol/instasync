import * as Y from "yjs";
import { TFile, Notice, normalizePath } from "obsidian";
import type RealtimePlugin from "./main";
import { applyTextToYText } from "./diff";
import { dbg, snip } from "./debug";
import { ensureParentFolder, getFileByPath, isOpenInWorkspace } from "./vaultHelpers";
import { openTextConflictModal } from "./TextConflictModal";
import { SyncedDoc } from "./SyncedDoc";

/**
 * Origin tag used on Yjs transactions that originate from this Document writing
 * disk content into the shared text, so our own ytext observer can ignore them.
 */
const DISK_ORIGIN = Symbol("realtime-disk");

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
export class Document extends SyncedDoc {
	readonly ytext: Y.Text;

	/** Number of CodeMirror editors currently bound to this document. */
	private boundEditors = 0;
	/** True while we are writing ytext content to disk (to ignore the echo). */
	private writingToDisk = false;
	/** Disk content captured at startup, before remote sync (for conflict checks). */
	private diskAtStartup: string | null = null;
	/** Locally persisted Y.Text content before the first remote sync. */
	private baselineAtStartup = "";
	/** Whether the local disk diverged from the baseline at startup. */
	private localChangedAtStartup = false;
	/** Guards the one-time startup merge so reconnects don't re-run it. */
	private startupReconciled = false;

	private ytextObserver: () => void;
	private writeTimer: number | null = null;

	constructor(
		plugin: RealtimePlugin,
		path: string,
		guid: string,
		serverDocId: string,
		isCreator: boolean,
	) {
		super(plugin, path, guid, serverDocId, isCreator);
		this.ytext = this.ydoc.getText("contents");

		// ytext changes (local edits from other peers, or our own editor) flow to
		// disk only while no editor is bound — otherwise Obsidian persists the file.
		this.ytextObserver = this.onYTextChanged.bind(this);
		this.ytext.observe(this.ytextObserver);
	}

	get content(): string {
		return this.ytext.toString();
	}

	bindEditor(): void {
		this.boundEditors++;
		dbg("bindEditor", this.path, "count", this.boundEditors);
	}

	unbindEditor(): void {
		this.boundEditors = Math.max(0, this.boundEditors - 1);
		dbg("unbindEditor", this.path, "count", this.boundEditors);
		if (this.boundEditors !== 0 || this.destroyed) return;
		// Obsidian destroys and immediately recreates the editor's view plugins on
		// mode switches (Live Preview ↔ Source), splits, and re-layout — all while
		// the file stays open — transiently dropping the count to zero. Defer a tick
		// so a rebind cancels the flush, and never write while the file is still
		// open anywhere: a vault.modify on an open file surfaces to Obsidian as an
		// external change, which it then 3-way merges into its editor buffer,
		// duplicating the just-typed text (and that merge gets re-sent to peers).
		window.setTimeout(() => {
			if (this.destroyed || this.boundEditors > 0 || this.isOpenInWorkspace()) return;
			void this.writeToDisk(this.content);
		}, 0);
	}

	get hasBoundEditor(): boolean {
		return this.boundEditors > 0;
	}

	/**
	 * Startup sequence: load the persisted baseline, read local disk, then connect.
	 * Local disk edits are deliberately not folded into Y.Text until the first
	 * remote sync tells us whether the remote also changed from the baseline.
	 */
	protected async afterPersistenceSynced(): Promise<void> {
		const baseline = this.content;
		this.baselineAtStartup = baseline;
		const disk = await this.readFromDisk();
		this.diskAtStartup = disk;
		this.localChangedAtStartup = disk !== null && disk !== baseline;
	}

	/**
	 * Runs once, after the first successful server sync. Since local startup disk
	 * edits have not yet been applied, the current Y.Text is the pre-merge remote
	 * version. We compare baseline/local/remote and publish exactly one canonical
	 * version.
	 *  - pure remote update            -> write the merged text to disk;
	 *  - local-only fast-forward       -> apply local disk to Y.Text;
	 *  - both sides changed (conflict) -> prompt for local vs remote, then apply
	 *                                     the chosen text as canonical.
	 */
	protected async finishStartupReconcile(): Promise<void> {
		if (this.startupReconciled || this.destroyed) return;
		this.startupReconciled = true;

		try {
			const remote = this.content;
			const baseline = this.baselineAtStartup;
			const localDisk = this.diskAtStartup;
			const remoteChanged = remote !== baseline;

			const isConflict =
				this.localChangedAtStartup && localDisk !== null && remoteChanged && remote !== localDisk;

			if (isConflict) {
				const choice = await openTextConflictModal(this.plugin, {
					path: this.path,
					localContent: localDisk,
					remoteContent: remote,
				});
				if (this.destroyed) return;
				if (choice === "local") {
					this.applyText(localDisk);
					new Notice(`Realtime: kept your local version of "${this.path}".`);
				} else {
					new Notice(`Realtime: kept the remote version of "${this.path}".`);
				}
			} else if (this.localChangedAtStartup && localDisk !== null && !remoteChanged) {
				this.applyText(localDisk);
			}

			// The editor (if open) receives the merged text via the ytext observer;
			// writing through vault.modify would make Obsidian merge an external change.
			if (!this.hasBoundEditor && !this.isOpenInWorkspace()) {
				await this.writeToDisk(this.content);
			}
		} catch (e) {
			console.error(`[Realtime] startup reconcile failed for ${this.path}`, e);
		} finally {
			this.resolveWhenReady();
		}
	}

	private applyText(text: string): void {
		this.ydoc.transact(() => {
			applyTextToYText(this.ytext, text, DISK_ORIGIN);
		}, DISK_ORIGIN);
	}

	private onYTextChanged(): void {
		if (this.destroyed) return;
		// Note text-sync activity so the binary upload queue can defer large
		// transfers while notes are actively syncing.
		this.plugin.vaultSync?.noteTextActivity();
		// While a note is open, Obsidian owns its editor buffer and persistence;
		// writing through vault.modify would appear as an external file change.
		if (this.hasBoundEditor || this.isOpenInWorkspace()) return;
		this.scheduleWriteToDisk();
	}

	private scheduleWriteToDisk(): void {
		if (this.writeTimer !== null) {
			window.clearTimeout(this.writeTimer);
		}
		this.writeTimer = window.setTimeout(() => {
			this.writeTimer = null;
			// Re-check at fire time, not just when scheduled: the note may have been
			// opened during the debounce window. Writing through vault.modify onto a
			// now-open file makes Obsidian report an external change and 3-way-merge
			// it into the editor buffer, duplicating text (which is then re-sent).
			if (this.destroyed || this.hasBoundEditor || this.isOpenInWorkspace()) return;
			void this.writeToDisk(this.content);
		}, 100);
	}

	/** Called by VaultSync when the local file changed and no editor is bound. */
	async onDiskChanged(): Promise<void> {
		if (this.destroyed || this.writingToDisk || this.hasBoundEditor || this.isOpenInWorkspace()) return;
		const disk = await this.readFromDisk();
		if (disk === null) return;
		if (disk === this.content) return;
		this.plugin.vaultSync?.noteTextActivity();
		dbg("onDiskChanged FOLD disk->ytext", this.path, "disk", snip(disk), "ytext", snip(this.content));
		this.ydoc.transact(() => {
			applyTextToYText(this.ytext, disk, DISK_ORIGIN);
		}, DISK_ORIGIN);
	}

	private getFile(): TFile | null {
		return getFileByPath(this.plugin.app, this.path);
	}

	private isOpenInWorkspace(): boolean {
		return isOpenInWorkspace(this.plugin.app, this.path);
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
				// Never modify a file that is open in an editor — Obsidian owns its
				// buffer and persistence, and a vault.modify would surface as an
				// external change it 3-way-merges, duplicating text. This is the last
				// line of defence behind the callers' own open-state checks (which can
				// race an open that happens during an awaited read/schedule).
				if (this.hasBoundEditor || this.isOpenInWorkspace()) {
					dbg("writeToDisk SKIP (open/bound)", this.path, "bound", this.boundEditors, "open", this.isOpenInWorkspace());
					return;
				}
				if ((await this.plugin.app.vault.read(file)) === text) return;
				dbg("%cwriteToDisk MODIFY", "color:orange", this.path, snip(text), "bound", this.boundEditors, "open", this.isOpenInWorkspace());
				await this.plugin.app.vault.modify(file, text);
			} else {
				// Remote-created file that does not exist locally yet.
				const path = normalizePath(this.path);
				await ensureParentFolder(this.plugin.app, path);
				await this.plugin.app.vault.create(path, text);
			}
		} catch (e) {
			console.error(`[Realtime] writeToDisk failed for ${this.path}`, e);
		} finally {
			// Release on the next tick so the resulting vault 'modify' event,
			// which is dispatched asynchronously, is still treated as our own.
			window.setTimeout(() => {
				this.writingToDisk = false;
			}, 0);
		}
	}

	protected destroySubclass(): void {
		if (this.writeTimer !== null) {
			window.clearTimeout(this.writeTimer);
			this.writeTimer = null;
		}
		this.ytext.unobserve(this.ytextObserver);
	}
}
