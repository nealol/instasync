import { Menu, MenuItem, Notice, Plugin, TFile } from "obsidian";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { RealtimeSettings, RealtimeSettingTab, defaultSettings } from "./settings";
import { VaultSync, isConflictCopy } from "./VaultSync";
import type { UploadStatus } from "./BinarySync";
import { matchesAnyGlob, parseGlobs } from "./glob";
import type { SyncedDoc } from "./SyncedDoc";
import { AuthClient, AuthError, normalizeServerUrl } from "./auth";
import { PLUGIN_NAME } from "./brand";
import { liveEdit } from "./editor/LiveEdit";
import { yRemoteSelections, yRemoteSelectionsTheme } from "./editor/RemoteSelections";
import { setDiagnosticLoggingEnabled } from "./debug";

type ConnectionStatus = "offline" | "connecting" | "connected" | "error" | "signin";

const STATUS_TEXT: Record<ConnectionStatus, string> = {
	offline: "Sync: offline",
	connecting: "Sync: connecting…",
	connected: "Sync: live",
	error: "Sync: offline",
	signin: "Sync: sign in",
};

export default class RealtimePlugin extends Plugin {
	settings!: RealtimeSettings;
	auth!: AuthClient;
	vaultSync: VaultSync | null = null;
	private statusBarEl!: HTMLElement;
	private statusRoot: Root | null = null;
	private status: ConnectionStatus = "offline";
	/** Attachment upload activity; overrides the "live" label when connected. */
	private uploadStatus: UploadStatus = "idle";

	async onload(): Promise<void> {
		await this.loadSettings();
		this.auth = new AuthClient(this);

		this.addSettingTab(new RealtimeSettingTab(this.app, this));

		this.statusBarEl = this.addStatusBarItem();
		this.renderStatus();

		// Editor extensions: live editing + remote cursors.
		this.registerEditorExtension([liveEdit, yRemoteSelections, yRemoteSelectionsTheme]);

		// Deep link back from the SSO login page: obsidian://realtime-auth?token=…
		this.registerObsidianProtocolHandler("realtime-auth", (params) => {
			void (async () => {
				try {
					await this.auth.handleProtocol(params as Record<string, string>);
					new Notice(`${PLUGIN_NAME}: signed in.`);
					await this.onLoggedIn();
				} catch (e) {
					console.error(`[${PLUGIN_NAME}] sign-in callback failed`, e);
					new Notice(`${PLUGIN_NAME}: sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
				}
			})();
		});

		this.registerObsidianProtocolHandler("realtime-open", (params) => {
			void this.openRealtimeLink(params as Record<string, string>);
		});

		this.addCommand({
			id: "realtime-reconnect",
			name: "Reconnect to server",
			callback: () => this.reloadSync(),
		});
		this.addCommand({
			id: "realtime-setup-vault",
			name: "Set up vault",
			callback: () => {
				new Notice(`${PLUGIN_NAME}: open Settings → ${PLUGIN_NAME} to set up this vault.`);
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
			this.app.workspace.on("active-leaf-change", () => {
				this.vaultSync?.reconnectAll();
				this.vaultSync?.bindOpenCanvases();
				this.vaultSync?.bindOpenBases();
			}),
		);

		// Add "as Realtime Permalink" under the file tree's native "Copy path >" submenu.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFile) this.addPermalinkMenuItem(menu, file);
			}),
		);

		// Wait for the vault to finish loading before scanning files.
		this.app.workspace.onLayoutReady(() => void this.maybeStartSync());
	}

	onunload(): void {
		this.stopSync();
		this.auth?.destroy();
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
		// Resolve this server's stable id and migrate any legacy token into the
		// per-server SecretStorage key. Best-effort: tolerate offline startups,
		// where the legacy key keeps working until we can reach the server.
		await this.auth.ensureServerId().catch(() => {});
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
		this.uploadStatus = "idle";
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
			this.setStatus("signin");
		} else {
			await this.reloadSync();
		}
	}

	async logout(): Promise<void> {
		this.stopSync();
		await this.auth.logout();
		this.setStatus("signin");
	}

	private async openRealtimeLink(params: Record<string, string>): Promise<void> {
		try {
			// `vault` is reserved by Obsidian's URI router; permalinks pass the
			// vault id as `vaultId`. Fall back to the legacy `vault` param just in
			// case one reaches us (older links that slipped past Obsidian).
			const vaultId = (params.vaultId ?? params.vault)?.trim();
			if (!vaultId || vaultId !== this.settings.activeVaultId) {
				new Notice(`${PLUGIN_NAME}: this link is for a different vault.`);
				return;
			}

			let path = params.path?.trim() || "";
			const guid = params.guid?.trim();
			if (!path && guid) {
				path = this.vaultSync?.pathForGuid(guid) ?? "";
			}
			if (!path) {
				new Notice(`${PLUGIN_NAME}: note link is not available locally yet.`);
				return;
			}

			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				new Notice(`${PLUGIN_NAME}: note not found: ${path}`);
				return;
			}
			await this.app.workspace.getLeaf(false).openFile(file);
		} catch (e) {
			console.error(`[${PLUGIN_NAME}] failed to open permalink`, e);
			new Notice(`${PLUGIN_NAME}: failed to open link: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * Inject "as Realtime Permalink" into the file tree context menu. Obsidian's
	 * core renders a native "Copy path >" submenu; we slot our option in there when
	 * we can find it, and otherwise fall back to a top-level "Copy Realtime
	 * permalink" item so the action is always reachable.
	 */
	private addPermalinkMenuItem(menu: Menu, file: TFile): void {
		const build = (item: MenuItem, title: string) => {
			item
				.setTitle(title)
				.setIcon("link")
				.onClick(() => void this.copyRealtimePermalink(file));
		};
		const submenu = findCopyPathSubmenu(menu);
		if (submenu) {
			submenu.addItem((item) => build(item, "as Realtime Permalink"));
		} else {
			menu.addItem((item) => build(item, "Copy Realtime permalink"));
		}
	}

	/** Resolve and copy a stable permalink for the given file to the clipboard. */
	private async copyRealtimePermalink(file: TFile): Promise<void> {
		try {
			const vaultId = this.settings.activeVaultId;
			if (!vaultId) {
				new Notice(`${PLUGIN_NAME}: set up a vault before copying a permalink.`);
				return;
			}
			if (!this.auth.isLoggedIn) {
				new Notice(`${PLUGIN_NAME}: sign in to copy a permalink.`);
				return;
			}
			const { url } = await this.auth.notePermalink(vaultId, file.path);
			await navigator.clipboard?.writeText(url);
			new Notice(`${PLUGIN_NAME}: permalink copied.`);
		} catch (e) {
			console.error(`[${PLUGIN_NAME}] failed to copy permalink`, e);
			new Notice(
				`${PLUGIN_NAME}: failed to copy permalink: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
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

		this.stopSync();
		await this.wipeLocalSyncedFiles();
		this.settings.activeVaultId = vaultId;
		await this.saveSettings();
		await this.reloadSync();
		new Notice(`${PLUGIN_NAME}: adopting "${name}"…`);
	}

	/**
	 * Erase local files that Realtime would sync (Markdown, plus binaries when
	 * enabled) so the adopted vault's contents replace them cleanly — otherwise
	 * local-only files would be pushed up as new additions.
	 */
	private async wipeLocalSyncedFiles(): Promise<void> {
		const excludes = parseGlobs(this.settings.binaryExcludeGlobs);
		const targets = this.app.vault.getFiles();
		for (const file of targets) {
			if (isConflictCopy(file.path)) continue;
			if (file.extension === "md") {
				// Always synced through the text CRDT.
			} else if (file.extension === "canvas" && this.settings.syncCanvases) {
				// Synced through the structured CRDT.
			} else if (file.extension === "base" && this.settings.syncBases) {
				// Synced through the structured CRDT.
			} else if (!this.settings.syncBinaries || matchesAnyGlob(file.path, excludes)) {
				continue;
			}
			try {
				await this.app.vault.delete(file);
			} catch (e) {
				console.error(`[${PLUGIN_NAME}] failed to erase ${file.path}`, e);
			}
		}
	}

	// --- Awareness / identity --------------------------------------------------

	/** Sets this client's cursor identity on a single document's awareness. */
	applyAwarenessTo(doc: SyncedDoc): void {
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

	/** Reflect attachment upload activity (called by {@link BinarySync}). */
	setUploadStatus(status: UploadStatus): void {
		if (this.uploadStatus === status) return;
		this.uploadStatus = status;
		this.renderStatus();
	}

	private renderStatus(): void {
		if (!this.statusBarEl) return;
		this.statusRoot ??= createRoot(this.statusBarEl);
		// Attachment upload activity takes precedence over the plain "live" label.
		let text = STATUS_TEXT[this.status];
		if (this.status === "connected") {
			if (this.uploadStatus === "uploading") text = "Sync: uploading";
			else if (this.uploadStatus === "pending") text = "Sync: pending upload";
		}
		flushSync(() => {
			this.statusRoot?.render(text);
		});
	}

	// --- Settings persistence --------------------------------------------------

	async loadSettings(): Promise<void> {
		const raw = await this.loadData();
		this.settings = sanitizeSettings(raw);
		// Migrate legacy plaintext token from data.json to SecretStorage.
		const legacy = raw && typeof raw === "object" ? (raw as Record<string, unknown>).sessionToken : undefined;
		if (typeof legacy === "string" && legacy) {
			this.app.secretStorage.setSecret("realtime-session-token", legacy);
			await this.saveSettings();
		}
		this.applyDiagnosticLoggingSetting();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	applyDiagnosticLoggingSetting(): void {
		setDiagnosticLoggingEnabled(!!this.settings.diagnosticLogging);
	}
}

/**
 * Obsidian's bundled types don't expose a menu's items or an item's submenu,
 * but both exist at runtime — the native "Copy path >" entry is a MenuItem with
 * a populated `submenu`. We read these defensively so a future API change just
 * trips the top-level fallback instead of throwing.
 */
interface InternalMenuItem extends MenuItem {
	submenu?: Menu | null;
	titleEl?: HTMLElement;
	dom?: HTMLElement;
}
interface InternalMenu extends Menu {
	items?: MenuItem[];
}

/** Locate the native "Copy path" submenu within a file-menu, if present. */
function findCopyPathSubmenu(menu: Menu): Menu | null {
	const items = (menu as InternalMenu).items;
	if (!Array.isArray(items)) return null;
	for (const raw of items) {
		const item = raw as InternalMenuItem;
		if (!item.submenu) continue;
		const title = (item.titleEl?.textContent ?? item.dom?.textContent ?? "")
			.trim()
			.toLowerCase();
		if (title.includes("copy path")) return item.submenu;
	}
	return null;
}

function sanitizeSettings(raw: unknown): RealtimeSettings {
	const defaults = defaultSettings();
	const data = raw && typeof raw === "object" ? raw as Partial<RealtimeSettings> : {};
	const settings: RealtimeSettings = { ...defaults };

	settings.authServerUrl = sanitizeUrl(data.authServerUrl, defaults.authServerUrl);
	settings.authServerId = typeof data.authServerId === "string" ? data.authServerId.trim() : "";
	settings.pendingSetupServerUrl = data.pendingSetupServerUrl
		? sanitizeUrl(data.pendingSetupServerUrl, "")
		: "";
	settings.userDisplayName = typeof data.userDisplayName === "string" ? data.userDisplayName : "";
	settings.userEmail = typeof data.userEmail === "string" ? data.userEmail : "";
	settings.activeVaultId = typeof data.activeVaultId === "string" ? data.activeVaultId.trim() : "";
	settings.clientName = typeof data.clientName === "string" && data.clientName.trim()
		? data.clientName.trim()
		: defaults.clientName;
	settings.clientColor = sanitizeColor(data.clientColor, defaults.clientColor);
	settings.clientColorLight = sanitizeColor(data.clientColorLight, defaults.clientColorLight);
	settings.enabled = typeof data.enabled === "boolean" ? data.enabled : defaults.enabled;
	settings.syncBinaries = typeof data.syncBinaries === "boolean" ? data.syncBinaries : defaults.syncBinaries;
	settings.syncCanvases = typeof data.syncCanvases === "boolean" ? data.syncCanvases : defaults.syncCanvases;
	settings.syncBases = typeof data.syncBases === "boolean" ? data.syncBases : defaults.syncBases;
	settings.binaryExcludeGlobs = typeof data.binaryExcludeGlobs === "string" ? data.binaryExcludeGlobs : "";
	settings.syncConfigEnabled = typeof data.syncConfigEnabled === "boolean" ? data.syncConfigEnabled : false;
	settings.configIncludeGlobs = Array.isArray(data.configIncludeGlobs)
		? data.configIncludeGlobs.filter((glob): glob is string => typeof glob === "string").map((glob) => glob.trim()).filter(Boolean)
		: [];
	settings.diagnosticLogging = typeof data.diagnosticLogging === "boolean" ? data.diagnosticLogging : false;

	return settings;
}

function sanitizeUrl(value: unknown, fallback: string): string {
	if (typeof value !== "string" || !value.trim()) return fallback;
	try {
		return normalizeServerUrl(value);
	} catch {
		return fallback;
	}
}

function sanitizeColor(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value) ? value : fallback;
}
