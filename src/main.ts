import { Menu, MenuItem, Notice, Plugin, TFile } from "obsidian";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { RealtimeSettings, RealtimeSettingTab, defaultSettings } from "./settings";
import { VaultSync, isConflictCopy } from "./VaultSync";
import type { UploadStatus } from "./BinarySync";
import { matchesAnyGlob, parseGlobs } from "./glob";
import type { SyncedDoc } from "./SyncedDoc";
import { AuthClient, AuthError, normalizeServerUrl } from "./auth";
import { CompatibilityError } from "./caps";
import { PLUGIN_NAME } from "./brand";
import { liveEdit } from "./editor/LiveEdit";
import { yRemoteSelections, yRemoteSelectionsTheme } from "./editor/RemoteSelections";
import { setDiagnosticLoggingEnabled } from "./debug";
import { openTrashModal } from "./TrashModal";
import { FILE_HISTORY_VIEW_TYPE, FileHistoryView } from "./history/FileHistoryView";
import { openTimelineModal } from "./history/TimelineModal";
import { RealtimeSqlAPI } from "./pluginDb/api";
import { RealtimeCursorsAPI } from "./cursors/api";
import type {
  RealtimeCursors,
  RealtimePluginApi,
  RealtimeSql,
} from "@realtime-md/plugin-api-types";

type ConnectionStatus = "offline" | "connecting" | "connected" | "error" | "signin";

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  offline: "Realtime: offline",
  connecting: "Realtime: connecting…",
  connected: "Realtime: live",
  error: "Realtime: offline",
  signin: "Realtime: sign in",
};

export default class RealtimePlugin extends Plugin implements RealtimePluginApi {
  settings!: RealtimeSettings;
  auth!: AuthClient;
  vaultSync: VaultSync | null = null;
  /**
   * Last compatibility-gating failure from `Auth.serverInfoChecked`, or `null`
   * when the last check passed (or the server was lenient/old). Non-persisted:
   * updated by auth on every server-info fetch, read by the settings banner.
   * Not saved to settings — it reflects the live server, not user config.
   */
  lastCompatibilityError: {
    reason: "server-incompatible" | "client-too-old";
    detail: string;
    serverVersion?: string;
  } | null = null;
  /** Synced-SQLite API for third-party plugins (see src/pluginDb, docs/plugin-sql). */
  sqlApi!: RealtimeSqlAPI;
  /** Public handle: `app.plugins.plugins["realtime"].sql` — typed by @realtime-md/plugin-api-types. */
  get sql(): RealtimeSql {
    return this.sqlApi;
  }
  /** Plugin-managed remote cursor API for third-party plugins (see src/cursors/api.ts). */
  cursorsApi!: RealtimeCursorsAPI;
  /** Public handle: `app.plugins.plugins["realtime"].cursors` — typed by @realtime-md/plugin-api-types. */
  get cursors(): RealtimeCursors {
    return this.cursorsApi;
  }
  private statusBarEl!: HTMLElement;
  private statusRoot: Root | null = null;
  private status: ConnectionStatus = "offline";
  /** Attachment upload activity; overrides the "live" label when connected. */
  private uploadStatus: UploadStatus = "idle";

  async onload(): Promise<void> {
    await this.loadSettings();
    this.auth = new AuthClient(this);
    this.sqlApi = new RealtimeSqlAPI(this);
    this.cursorsApi = new RealtimeCursorsAPI(this);

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
          new Notice(
            `${PLUGIN_NAME}: sign-in failed: ${e instanceof Error ? e.message : String(e)}`,
          );
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
      id: "realtime-open-trash",
      name: "Open trash",
      callback: () => {
        if (!this.vaultSync) {
          new Notice(`${PLUGIN_NAME}: connect to your vault to view trash.`);
          return;
        }
        openTrashModal(this);
      },
    });
    this.registerView(FILE_HISTORY_VIEW_TYPE, (leaf) => new FileHistoryView(leaf, this));
    this.addCommand({
      id: "realtime-open-file-history",
      name: "Open file history",
      callback: () => void this.activateFileHistoryView(),
    });
    this.addCommand({
      id: "realtime-open-timeline",
      name: "Open vault history timeline",
      callback: () => {
        if (!this.settings.activeVaultId) {
          new Notice(`${PLUGIN_NAME}: connect to your vault to view history.`);
          return;
        }
        openTimelineModal(this);
      },
    });
    this.addRibbonIcon("history", "Realtime: file history", () => {
      void this.activateFileHistoryView();
    });

    this.addCommand({
      id: "realtime-rebase-plugin-dbs",
      name: "Rebase plugin databases from server",
      callback: () => {
        void (async () => {
          const n = await this.sqlApi.rebaseAll();
          new Notice(`${PLUGIN_NAME}: rebased ${n} plugin database(s) from server.`);
        })();
      },
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
    this.registerInterval(window.setInterval(() => this.vaultSync?.reconnectAll(), 10_000));
    this.registerDomEvent(window, "online", () => this.vaultSync?.reconnectAll());
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") this.vaultSync?.reconnectAll();
    });
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.vaultSync?.reconnectAll();
        const file = this.app.workspace.getActiveFile();
        if (file) this.vaultSync?.prioritizeItem({ path: file.path });
        this.vaultSync?.bindOpenCanvases();
        this.vaultSync?.bindOpenBases();
        // Canvas views may not have their private `canvas` object ready when
        // active-leaf-change fires (the view mounts asynchronously). A short
        // delayed retry catches slow-mounting views without a polling loop.
        window.setTimeout(() => {
          this.vaultSync?.bindOpenCanvases();
          this.vaultSync?.bindOpenBases();
        }, 300);
      }),
    );

    // file-open fires when a file becomes active in a leaf — covers views
    // that mount without an active-leaf transition (hover, pinning, etc.).
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        const file = this.app.workspace.getActiveFile();
        if (file) void this.recordRecentPath(file.path);
        if (file) this.vaultSync?.prioritizeItem({ path: file.path });
        this.vaultSync?.bindOpenCanvases();
        this.vaultSync?.bindOpenBases();
      }),
    );

    // layout-change fires on any workspace rearrangement (splits, drag,
    // pin/unpin). Debounce because it can fire rapidly during interactions.
    let layoutBindTimer: number | null = null;
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        if (layoutBindTimer !== null) window.clearTimeout(layoutBindTimer);
        layoutBindTimer = window.setTimeout(() => {
          layoutBindTimer = null;
          this.vaultSync?.bindOpenCanvases();
          this.vaultSync?.bindOpenBases();
        }, 200);
      }),
    );

    // Add "as Realtime Permalink" under the file tree's native "Copy path >" submenu.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        this.addPermalinkMenuItem(menu, file);
        if (file.extension === "md") this.addPublicShareMenuItems(menu, file);
      }),
    );
    this.addCommand({
      id: "realtime-share-publicly",
      name: "Share current note publicly",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file) void this.sharePublicly(file);
        else new Notice(`${PLUGIN_NAME}: no active note to share.`);
      },
    });
    this.addCommand({
      id: "realtime-stop-sharing-publicly",
      name: "Stop publicly sharing current note",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file) void this.stopSharingPublicly(file);
        else new Notice(`${PLUGIN_NAME}: no active note.`);
      },
    });

    // Wait for the vault to finish loading before scanning files.
    this.app.workspace.onLayoutReady(() => void this.maybeStartSync());
  }

  onunload(): void {
    this.cursorsApi?.destroy();
    void this.sqlApi?.destroy();
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
    // per-server SecretStorage key. Best-effort for network/offline errors
    // (tolerate offline startups, where the legacy key keeps working until we
    // can reach the server), but hard-block on compatibility failures: a cap
    // mismatch means continuing would corrupt state or hit immediate API
    // errors, so do not proceed to me()/startSync().
    try {
      await this.auth.ensureServerId();
    } catch (e) {
      if (e instanceof CompatibilityError) {
        // lastCompatibilityError is already set by serverInfoChecked; surface
        // it as the sync status and stop. Do not fall through to me().
        this.setStatus("offline");
        return;
      }
      // Other errors (network/offline) are tolerated as before.
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
    this.uploadStatus = "idle";
    this.setStatus("offline");
  }

  /** Reveal (or create) the file-history leaf in the right sidebar. */
  async activateFileHistoryView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(FILE_HISTORY_VIEW_TYPE)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: FILE_HISTORY_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
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

      const path = params.path?.trim() || "";
      const guid = params.guid?.trim();
      const found = await this.resolvePermalinkTarget(path, guid);
      if (found === undefined) return;
      if (found) {
        await this.app.workspace.getLeaf(false).openFile(found);
        return;
      }
      // Fallback notices — preserve current wording, decided by ORIGINAL inputs
      // (do not mutate `path`; a guid-only miss must stay "not available locally yet").
      if (guid && !path) {
        new Notice(`${PLUGIN_NAME}: note link is not available locally yet.`);
      } else {
        new Notice(`${PLUGIN_NAME}: note not found: ${path}`);
      }
    } catch (e) {
      console.error(`[${PLUGIN_NAME}] failed to open permalink`, e);
      new Notice(
        `${PLUGIN_NAME}: failed to open link: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Resolve a permalink target to a local {@link TFile}, attempting a one-shot
   * recovery (start sync / nudge reconnect, then wait up to 15s for the note to
   * materialize via the index merge + disk write). Returns null on a miss; the
   * caller decides the fallback notice from the ORIGINAL path/guid inputs.
   * Returns undefined when it already showed a more specific recovery-blocked
   * notice and the caller should not show a second fallback notice.
   */
  private async resolvePermalinkTarget(
    path: string,
    guid: string | undefined,
  ): Promise<TFile | null | undefined> {
    // Happy path (no wait): resolve a guid to its current index path, or use
    // the explicit path directly. `resolvedPath` is a separate var so the
    // original (possibly empty) `path` is preserved for the caller's fallback
    // notice wording.
    const resolvedPath = path || (guid ? this.vaultSync?.pathForGuid(guid) ?? "" : "");
    if (resolvedPath) {
      const file = this.app.vault.getAbstractFileByPath(resolvedPath);
      if (file instanceof TFile) return file;
    }

    // Miss → recover. Start sync if it isn't running yet (a single awaited
    // step; maybeStartSync sets this.vaultSync at its tail when preconditions
    // hold). The 15s below is the item-recovery budget, not a stacked wait.
    if (!this.vaultSync) {
      await this.maybeStartSync();
      if (!this.vaultSync) {
        // Not enabled / not logged in / no active vault — maybeStartSync already
        // surfaced the signin/offline status. No polling, no 15s wait.
        new Notice(`${PLUGIN_NAME}: sign in and enable sync to open this link.`);
        return undefined;
      }
    } else {
      // Nudge a stalled provider; no-op when already connected (harmless during
      // IndexedDB load since waitForItem tolerates that startup phase).
      this.vaultSync.reconnectAll();
    }

    this.vaultSync.prioritizeItem({ guid, path });

    const notice = new Notice("Realtime: syncing… looking for note", 15_000);
    const file = await this.vaultSync.waitForItem({ guid, path, timeoutMs: 15_000 });
    notice.hide();
    return file;
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

  /**
   * Public-share actions in the file context menu. Both items are always shown
   * (no async share lookup before the menu opens): "Share publicly" is
   * idempotent server-side and re-copies the existing link, and "Stop publicly
   * sharing" reports when the note was not shared.
   */
  private addPublicShareMenuItems(menu: Menu, file: TFile): void {
    menu.addItem((item) => {
      item
        .setTitle("Share publicly")
        .setIcon("globe")
        .onClick(() => void this.sharePublicly(file));
    });
    menu.addItem((item) => {
      item
        .setTitle("Stop publicly sharing")
        .setIcon("globe")
        .onClick(() => void this.stopSharingPublicly(file));
    });
  }

  /** Create (or fetch) the public share link for a note and copy it. */
  private async sharePublicly(file: TFile): Promise<void> {
    const vaultId = this.requireShareContext("share a note");
    if (!vaultId) return;
    try {
      const share = await this.auth.createPublicShare(vaultId, file.path);
      await navigator.clipboard?.writeText(share.url);
      new Notice(`${PLUGIN_NAME}: public link copied.`);
    } catch (e) {
      console.error(`[${PLUGIN_NAME}] failed to share publicly`, e);
      new Notice(`${PLUGIN_NAME}: failed to share: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Revoke the public share link for a note, if any. */
  private async stopSharingPublicly(file: TFile): Promise<void> {
    const vaultId = this.requireShareContext("stop sharing a note");
    if (!vaultId) return;
    try {
      await this.auth.deletePublicShare(vaultId, file.path);
      new Notice(`${PLUGIN_NAME}: note is no longer publicly shared.`);
    } catch (e) {
      if (e instanceof Error && e.message.includes("not found")) {
        new Notice(`${PLUGIN_NAME}: note was not publicly shared.`);
        return;
      }
      console.error(`[${PLUGIN_NAME}] failed to stop sharing`, e);
      new Notice(
        `${PLUGIN_NAME}: failed to stop sharing: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Common guard for share actions: needs an active vault and a session. */
  private requireShareContext(action: string): string | null {
    const vaultId = this.settings.activeVaultId;
    if (!vaultId) {
      new Notice(`${PLUGIN_NAME}: set up a vault before you ${action}.`);
      return null;
    }
    if (!this.auth.isLoggedIn) {
      new Notice(`${PLUGIN_NAME}: sign in to ${action}.`);
      return null;
    }
    return vaultId;
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
      if (this.uploadStatus === "uploading") text = "Realtime: uploading";
      else if (this.uploadStatus === "pending") text = "Realtime: pending upload";
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
    const legacy =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>).sessionToken : undefined;
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

  private async recordRecentPath(path: string): Promise<void> {
    if (!path.endsWith(".md") && !path.endsWith(".canvas") && !path.endsWith(".base")) return;
    const recent = [path, ...this.settings.recentPaths.filter((p) => p !== path)].slice(0, 25);
    this.settings.recentPaths = recent;
    await this.saveSettings();
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
    const title = (item.titleEl?.textContent ?? item.dom?.textContent ?? "").trim().toLowerCase();
    if (title.includes("copy path")) return item.submenu;
  }
  return null;
}

function sanitizeSettings(raw: unknown): RealtimeSettings {
  const defaults = defaultSettings();
  const data = raw && typeof raw === "object" ? (raw as Partial<RealtimeSettings>) : {};
  const settings: RealtimeSettings = { ...defaults };

  settings.authServerUrl = sanitizeUrl(data.authServerUrl, defaults.authServerUrl);
  settings.authServerId = typeof data.authServerId === "string" ? data.authServerId.trim() : "";
  settings.pendingSetupServerUrl = data.pendingSetupServerUrl
    ? sanitizeUrl(data.pendingSetupServerUrl, "")
    : "";
  settings.userId = typeof data.userId === "string" ? data.userId : "";
  settings.userDisplayName = typeof data.userDisplayName === "string" ? data.userDisplayName : "";
  settings.userEmail = typeof data.userEmail === "string" ? data.userEmail : "";
  settings.gitEmail = typeof data.gitEmail === "string" ? data.gitEmail : "";
  settings.activeVaultId = typeof data.activeVaultId === "string" ? data.activeVaultId.trim() : "";
  settings.clientName =
    typeof data.clientName === "string" && data.clientName.trim()
      ? data.clientName.trim()
      : defaults.clientName;
  settings.clientColor = sanitizeColor(data.clientColor, defaults.clientColor);
  settings.clientColorLight = sanitizeColor(data.clientColorLight, defaults.clientColorLight);
  settings.enabled = typeof data.enabled === "boolean" ? data.enabled : defaults.enabled;
  settings.syncBinaries =
    typeof data.syncBinaries === "boolean" ? data.syncBinaries : defaults.syncBinaries;
  settings.syncCanvases =
    typeof data.syncCanvases === "boolean" ? data.syncCanvases : defaults.syncCanvases;
  settings.syncBases = typeof data.syncBases === "boolean" ? data.syncBases : defaults.syncBases;
  settings.binaryExcludeGlobs =
    typeof data.binaryExcludeGlobs === "string" ? data.binaryExcludeGlobs : "";
  settings.syncConfigEnabled =
    typeof data.syncConfigEnabled === "boolean" ? data.syncConfigEnabled : false;
  settings.configIncludeGlobs = Array.isArray(data.configIncludeGlobs)
    ? data.configIncludeGlobs
        .filter((glob): glob is string => typeof glob === "string")
        .map((glob) => glob.trim())
        .filter(Boolean)
    : [];
  settings.diagnosticLogging =
    typeof data.diagnosticLogging === "boolean" ? data.diagnosticLogging : false;
  settings.recentPaths = Array.isArray(data.recentPaths)
    ? data.recentPaths.filter((path): path is string => typeof path === "string").slice(0, 25)
    : [];

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
