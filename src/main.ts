import { Plugin } from "obsidian";
import { InstaSyncSettings, InstaSyncSettingTab, defaultSettings } from "./settings";
import { VaultSync } from "./VaultSync";
import type { Document } from "./Document";
import { liveEdit } from "./editor/LiveEdit";
import { yRemoteSelections, yRemoteSelectionsTheme } from "./editor/RemoteSelections";

type ConnectionStatus = "offline" | "connecting" | "connected" | "error";

const STATUS_TEXT: Record<ConnectionStatus, string> = {
	offline: "InstaSync: off",
	connecting: "InstaSync: connecting…",
	connected: "InstaSync: live",
	error: "InstaSync: error",
};

export default class InstaSyncPlugin extends Plugin {
	settings!: InstaSyncSettings;
	vaultSync: VaultSync | null = null;
	private statusBarEl!: HTMLElement;
	private status: ConnectionStatus = "offline";

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new InstaSyncSettingTab(this.app, this));

		this.statusBarEl = this.addStatusBarItem();
		this.renderStatus();

		// Editor extensions: live editing + remote cursors.
		this.registerEditorExtension([liveEdit, yRemoteSelections, yRemoteSelectionsTheme]);

		this.addCommand({
			id: "instasync-reconnect",
			name: "Reconnect to server",
			callback: () => this.reloadSync(),
		});

		// Aggressively recover connectivity after transient drops. The provider's
		// own backoff caps at ~5s, so these nudges (and OS-level signals) shorten
		// real-world downtime and revive sockets left dead by sleep/network changes.
		this.registerInterval(
			window.setInterval(() => this.vaultSync?.reconnectAll(), 10_000),
		);
		this.registerDomEvent(window, "online", () => this.vaultSync?.reconnectAll());
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible") this.vaultSync?.reconnectAll();
		});
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.vaultSync?.reconnectAll()),
		);

		// Wait for the vault to finish loading before scanning files.
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.enabled) this.startSync();
		});
	}

	onunload(): void {
		this.stopSync();
	}

	// --- Sync lifecycle --------------------------------------------------------

	private startSync(): void {
		if (this.vaultSync) return;
		if (!this.settings.serverUrl) {
			this.setStatus("error");
			return;
		}
		this.setStatus("connecting");
		this.vaultSync = new VaultSync(this);
		// Apply this client's identity to documents as they are created.
		this.updateLocalAwareness();
	}

	private stopSync(): void {
		this.vaultSync?.destroy();
		this.vaultSync = null;
		this.setStatus("offline");
	}

	async reloadSync(): Promise<void> {
		this.stopSync();
		if (this.settings.enabled) this.startSync();
	}

	// --- Awareness / identity --------------------------------------------------

	/** Sets this client's cursor identity on a single document's awareness. */
	applyAwarenessTo(doc: Document): void {
		doc.awareness.setLocalStateField("user", {
			name: this.settings.clientName,
			color: this.settings.clientColor,
			colorLight: this.settings.clientColorLight,
		});
	}

	/** Re-applies the identity to all live documents (after a settings change). */
	updateLocalAwareness(): void {
		if (!this.vaultSync) return;
		for (const doc of this.vaultSync.allDocuments()) {
			this.applyAwarenessTo(doc);
		}
	}

	// --- Status bar ------------------------------------------------------------

	setStatus(status: ConnectionStatus): void {
		this.status = status;
		this.renderStatus();
	}

	private renderStatus(): void {
		if (!this.statusBarEl) return;
		this.statusBarEl.setText(STATUS_TEXT[this.status]);
	}

	// --- Settings persistence --------------------------------------------------

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, defaultSettings(), await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
