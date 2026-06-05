import { Notice, Plugin } from "obsidian";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { InstaSyncSettings, InstaSyncSettingTab, defaultSettings } from "./settings";
import { VaultSync, isConflictCopy } from "./VaultSync";
import type { Document } from "./Document";
import { AuthClient, AuthError } from "./auth";
import { ConfirmModal, OnboardingModal } from "./ui/modals";
import { liveEdit } from "./editor/LiveEdit";
import { yRemoteSelections, yRemoteSelectionsTheme } from "./editor/RemoteSelections";

type ConnectionStatus = "offline" | "connecting" | "connected" | "error" | "signin";

const STATUS_TEXT: Record<ConnectionStatus, string> = {
	offline: "InstaSync: off",
	connecting: "InstaSync: connecting…",
	connected: "InstaSync: live",
	error: "InstaSync: error",
	signin: "InstaSync: sign in",
};

export default class InstaSyncPlugin extends Plugin {
	settings!: InstaSyncSettings;
	auth!: AuthClient;
	vaultSync: VaultSync | null = null;
	private statusBarEl!: HTMLElement;
	private statusRoot: Root | null = null;
	private status: ConnectionStatus = "offline";

	async onload(): Promise<void> {
		await this.loadSettings();
		this.auth = new AuthClient(this);

		this.addSettingTab(new InstaSyncSettingTab(this.app, this));

		this.statusBarEl = this.addStatusBarItem();
		this.renderStatus();

		// Editor extensions: live editing + remote cursors.
		this.registerEditorExtension([liveEdit, yRemoteSelections, yRemoteSelectionsTheme]);

		// Deep link back from the SSO login page: obsidian://instasync-auth?token=…
		this.registerObsidianProtocolHandler("instasync-auth", (params) => {
			this.auth.handleProtocol(params as Record<string, string>);
			new Notice("InstaSync: signed in.");
			void this.onLoggedIn();
		});

		this.addCommand({
			id: "instasync-reconnect",
			name: "Reconnect to server",
			callback: () => this.reloadSync(),
		});
		this.addCommand({
			id: "instasync-setup-vault",
			name: "Set up vault",
			callback: () => {
				if (!this.auth.isLoggedIn) {
					new Notice("InstaSync: sign in first (Settings → InstaSync).");
					return;
				}
				new OnboardingModal(this.app, this).open();
			},
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
		this.app.workspace.onLayoutReady(() => void this.maybeStartSync());
	}

	onunload(): void {
		this.stopSync();
		this.statusRoot?.unmount();
		this.statusRoot = null;
	}

	// --- Sync lifecycle --------------------------------------------------------

	/** Start syncing only when enabled, signed in, and bound to a vault. */
	private async maybeStartSync(): Promise<void> {
		if (!this.settings.enabled) {
			this.setStatus("offline");
			return;
		}
		if (!this.auth.isLoggedIn) {
			this.setStatus("signin");
			return;
		}
		// Validate the session; a 401 clears it. Other (network) errors are
		// tolerated so we can still start and let the providers retry.
		try {
			await this.auth.me();
		} catch (e) {
			if (e instanceof AuthError) {
				this.setStatus("signin");
				return;
			}
		}
		if (!this.settings.activeVaultId) {
			this.setStatus("signin");
			return;
		}
		this.startSync();
	}

	private startSync(): void {
		if (this.vaultSync) return;
		if (!this.settings.activeVaultId) {
			this.setStatus("signin");
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
		await this.maybeStartSync();
	}

	// --- Auth / onboarding -----------------------------------------------------

	/** Called after a successful login; prompts onboarding when no vault is set. */
	async onLoggedIn(): Promise<void> {
		if (!this.settings.activeVaultId) {
			new OnboardingModal(this.app, this).open();
		} else {
			await this.reloadSync();
		}
	}

	async logout(): Promise<void> {
		this.stopSync();
		await this.auth.logout();
		this.setStatus("signin");
	}

	/** Create a new server vault from the current local files and start syncing it. */
	async createAndActivateVault(name: string): Promise<void> {
		const vault = await this.auth.createVault(name);
		this.stopSync();
		this.settings.activeVaultId = vault.id;
		await this.saveSettings();
		// runInitialSync seeds the empty remote index from the local Markdown files.
		await this.reloadSync();
	}

	/**
	 * Replace local Markdown with a remote vault's contents. We stop sync first
	 * (detaching vault observers), erase local Markdown, bind the new vault, then
	 * start fresh — runInitialSync finds no local files to seed and instead pulls
	 * every remote file, so the startup conflict-copy path never triggers.
	 */
	async adoptVault(vaultId: string, name: string): Promise<void> {
		if (vaultId === this.settings.activeVaultId && this.vaultSync) return;

		const ok = await new ConfirmModal(
			this.app,
			"Adopt remote vault?",
			`This erases all Markdown in this local Obsidian vault and replaces it with "${name}". This cannot be undone.`,
			"Erase & adopt",
		).ask();
		if (!ok) return;

		this.stopSync();
		await this.wipeLocalMarkdown();
		this.settings.activeVaultId = vaultId;
		await this.saveSettings();
		await this.reloadSync();
		new Notice(`InstaSync: adopting "${name}"…`);
	}

	private async wipeLocalMarkdown(): Promise<void> {
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (isConflictCopy(file.path)) continue;
			try {
				await this.app.vault.delete(file);
			} catch (e) {
				console.error(`[InstaSync] failed to erase ${file.path}`, e);
			}
		}
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
		this.statusRoot ??= createRoot(this.statusBarEl);
		flushSync(() => {
			this.statusRoot?.render(STATUS_TEXT[this.status]);
		});
	}

	// --- Settings persistence --------------------------------------------------

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, defaultSettings(), await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
