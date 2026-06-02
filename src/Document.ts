import * as Y from "yjs";
import {
	YSweetProvider,
	STATUS_CONNECTED,
	EVENT_CONNECTION_STATUS,
	type YSweetStatus,
} from "@y-sweet/client";
import type { Awareness } from "y-protocols/awareness";
import { TFile, normalizePath } from "obsidian";
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

	/** Resolves once the provider has connected and initial reconciliation ran. */
	private readyPromise: Promise<void>;
	private resolveReady!: () => void;
	private reconciled = false;

	/** Whether this client created the index entry (and may seed an empty doc). */
	isCreator: boolean;

	private plugin: InstaSyncPlugin;
	private ytextObserver: () => void;
	private statusListener: (status: YSweetStatus) => void;
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

		this.provider = new YSweetProvider(
			() => getClientToken(plugin.settings.serverUrl, guid),
			guid,
			this.ydoc,
			{ connect: true, showDebuggerLink: false },
		);
		this.awareness = this.provider.awareness;

		// ytext changes (local edits from other peers, or our own editor) flow to
		// disk only while no editor is bound — otherwise Obsidian persists the file.
		this.ytextObserver = this.onYTextChanged.bind(this);
		this.ytext.observe(this.ytextObserver);

		this.statusListener = (status) => {
			if (status === STATUS_CONNECTED) {
				this.reconcile();
			}
		};
		this.provider.on(EVENT_CONNECTION_STATUS, this.statusListener);
		if (this.provider.status === STATUS_CONNECTED) {
			this.reconcile();
		}
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

	/**
	 * One-time reconciliation after the first connection completes:
	 *  - if the shared doc has content, it is authoritative -> write to disk;
	 *  - else if we created this entry, seed the shared doc from local file.
	 */
	private async reconcile(): Promise<void> {
		if (this.reconciled || this.destroyed) return;
		this.reconciled = true;

		const shared = this.content;
		try {
			if (shared.length > 0) {
				// Shared content wins. Don't fight an open editor; LiveEdit syncs it.
				if (!this.hasBoundEditor) {
					await this.writeToDisk(shared);
				}
			} else if (this.isCreator) {
				const local = await this.readFromDisk();
				if (local && local.length > 0) {
					this.ydoc.transact(() => {
						applyTextToYText(this.ytext, local, DISK_ORIGIN);
					}, DISK_ORIGIN);
				}
			}
		} catch (e) {
			console.error(`[InstaSync] reconcile failed for ${this.path}`, e);
		} finally {
			this.resolveReady();
		}
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
		this.provider.off(EVENT_CONNECTION_STATUS, this.statusListener);
		this.provider.destroy();
		this.ydoc.destroy();
	}
}
