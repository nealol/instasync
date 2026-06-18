import { App, Modal, Notice } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";
import type RealtimePlugin from "../main";
import { PLUGIN_NAME } from "../brand";
import type {
  CommitChange,
  CommitDetail,
  FileAtCommit,
  HistoryCommit,
  PluginDbPlan,
  RollbackPlan,
} from "./types";
import { HistoryFileDiff } from "./FileHistoryView";
import { BinaryPreview } from "./BinaryPreview";

/** Open the full-screen vault history timeline. */
export function openTimelineModal(plugin: RealtimePlugin, initialHash?: string): void {
  new TimelineModal(plugin.app, plugin, initialHash).open();
}

class TimelineModal extends Modal {
  private plugin: RealtimePlugin;
  private initialHash?: string;
  private root: Root | null = null;

  constructor(app: App, plugin: RealtimePlugin, initialHash?: string) {
    super(app);
    this.plugin = plugin;
    this.initialHash = initialHash;
  }

  onOpen(): void {
    this.modalEl.addClass("realtime-timeline-modal");
    this.root = createRoot(this.contentEl);
    this.root.render(<TimelineView plugin={this.plugin} initialHash={this.initialHash} />);
  }

  onClose(): void {
    this.root?.unmount();
    this.root = null;
    this.contentEl.empty();
  }
}

const PAGE_SIZE = 100;

function TimelineView({ plugin, initialHash }: { plugin: RealtimePlugin; initialHash?: string }) {
  const vaultId = plugin.settings.activeVaultId;
  const [commits, setCommits] = useState<HistoryCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<string | null>(initialHash ?? null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const loadPage = useCallback(
    async (before?: string) => {
      if (!vaultId || loadingRef.current) return;
      loadingRef.current = true;
      try {
        const page = await plugin.auth.listHistoryCommits(vaultId, {
          limit: PAGE_SIZE,
          before,
        });
        setCommits((prev) => (before ? [...prev, ...page.commits] : page.commits));
        setHasMore(page.hasMore);
        if (!before && !initialHash && page.commits.length > 0) {
          setSelected((cur) => cur ?? page.commits[0].hash);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        loadingRef.current = false;
      }
    },
    [plugin, vaultId, initialHash],
  );

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  useEffect(() => {
    if (!vaultId) return;
    void (async () => {
      try {
        const vaults = await plugin.auth.listVaults();
        setIsAdmin(vaults.find((v) => v.id === vaultId)?.role === "admin");
      } catch {
        setIsAdmin(false);
      }
    })();
  }, [plugin, vaultId]);

  if (!vaultId) {
    return <p className="setting-item-description">Connect to a vault to view its history.</p>;
  }

  return (
    <div className="realtime-timeline-shell">
      <div className="realtime-timeline-header">
        <h2>Vault history</h2>
        {error && <span className="realtime-history-error">{error}</span>}
      </div>
      <TimelineStrip
        commits={commits}
        selected={selected}
        onSelect={setSelected}
        onNearEnd={() => {
          if (hasMore) void loadPage(commits[commits.length - 1]?.hash);
        }}
      />
      {selected ? (
        <CommitDetailPane plugin={plugin} vaultId={vaultId} hash={selected} />
      ) : (
        <p className="setting-item-description">Select a commit.</p>
      )}
      {isAdmin && selected && (
        <RollbackBar
          plugin={plugin}
          vaultId={vaultId}
          hash={selected}
          onDone={() => void loadPage()}
        />
      )}
    </div>
  );
}

function relativeTime(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Horizontally virtualized strip of commit chips (newest first). */
function TimelineStrip({
  commits,
  selected,
  onSelect,
  onNearEnd,
}: {
  commits: HistoryCommit[];
  selected: string | null;
  onSelect: (hash: string) => void;
  onNearEnd: () => void;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 220,
    horizontal: true,
    overscan: 8,
  });

  const items = virtualizer.getVirtualItems();
  useEffect(() => {
    const last = items[items.length - 1];
    if (last && last.index >= commits.length - 10) onNearEnd();
  }, [items, commits.length, onNearEnd]);

  return (
    <div className="realtime-timeline-strip" ref={parentRef}>
      <div
        style={{
          width: virtualizer.getTotalSize(),
          height: "100%",
          position: "relative",
        }}
      >
        {items.map((item) => {
          const commit = commits[item.index];
          return (
            <div
              key={commit.hash}
              className={
                "realtime-timeline-chip" +
                (commit.hash === selected ? " is-selected" : "") +
                (commit.rollbackOf ? " is-rollback" : "")
              }
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                transform: `translateX(${item.start}px)`,
                width: item.size - 8,
              }}
              onClick={() => onSelect(commit.hash)}
            >
              <div className="realtime-timeline-chip-subject">{commit.subject}</div>
              <div className="realtime-timeline-chip-meta">
                {commit.cursorName ?? commit.authorName} · {relativeTime(commit.timestampMs)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const TREE_STATUS: Record<string, GitStatusEntry["status"]> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
};

/** Thin wrapper around `@pierre/trees`' FileTree for the changed-files pane. */
function HistoryFileTree({
  paths,
  gitStatus,
  onSelect,
}: {
  paths: string[];
  gitStatus: GitStatusEntry[];
  onSelect: (path: string) => void;
}) {
  const { model } = useFileTree({
    paths,
    gitStatus,
    onSelectionChange: (selectedPaths) => {
      const path = selectedPaths[0];
      if (path && paths.includes(path)) onSelect(path);
    },
  });
  return <FileTree model={model} className="realtime-timeline-tree" />;
}

function CommitDetailPane({
  plugin,
  vaultId,
  hash,
}: {
  plugin: RealtimePlugin;
  vaultId: string;
  hash: string;
}) {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setAllFiles(null);
    setShowAll(false);
    setSelectedPath(null);
    setError(null);
    void (async () => {
      try {
        const d = await plugin.auth.getHistoryCommit(vaultId, hash);
        setDetail(d);
        setSelectedPath(d.changes[0]?.renamedTo ?? d.changes[0]?.path ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [plugin, vaultId, hash]);

  useEffect(() => {
    if (!showAll || allFiles) return;
    void (async () => {
      try {
        const tree = await plugin.auth.getHistoryTree(vaultId, hash);
        setAllFiles(tree.entries.map((e) => e.path));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [showAll, allFiles, plugin, vaultId, hash]);

  const changes = detail?.changes ?? [];
  const changedPaths = useMemo(() => changes.map((c) => c.renamedTo ?? c.path), [changes]);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () =>
      changes
        .map((c) => ({
          path: c.renamedTo ?? c.path,
          status: TREE_STATUS[c.status] ?? ("modified" as const),
        }))
        .filter((e) => e.status !== undefined),
    [changes],
  );
  const treePaths = showAll && allFiles ? allFiles : changedPaths;
  const selectedChange: CommitChange | undefined = changes.find(
    (c) => (c.renamedTo ?? c.path) === selectedPath,
  );

  if (error) return <p className="setting-item-description realtime-history-error">{error}</p>;
  if (!detail) return <p className="setting-item-description">Loading…</p>;

  return (
    <div className="realtime-timeline-detail">
      <div className="realtime-timeline-files">
        <label className="realtime-timeline-toggle">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.currentTarget.checked)}
          />
          Show all files at this commit
        </label>
        {treePaths.length === 0 ? (
          <p className="setting-item-description">No files.</p>
        ) : (
          <HistoryFileTree
            key={`${hash}:${showAll && allFiles ? "all" : "changed"}`}
            paths={treePaths}
            gitStatus={gitStatus}
            onSelect={setSelectedPath}
          />
        )}
      </div>
      <div className="realtime-timeline-diff">
        {selectedPath ? (
          <PathAtCommit
            plugin={plugin}
            vaultId={vaultId}
            commit={detail.commit}
            path={selectedPath}
            oldPath={selectedChange?.renamedTo ? selectedChange.path : selectedPath}
            changed={!!selectedChange}
          />
        ) : (
          <p className="setting-item-description">Select a file.</p>
        )}
      </div>
    </div>
  );
}

function PathAtCommit({
  plugin,
  vaultId,
  commit,
  path,
  oldPath,
  changed,
}: {
  plugin: RealtimePlugin;
  vaultId: string;
  commit: HistoryCommit;
  path: string;
  oldPath: string;
  changed: boolean;
}) {
  const [files, setFiles] = useState<{ before: FileAtCommit; after: FileAtCommit } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parent = commit.parents[0] ?? null;

  useEffect(() => {
    setFiles(null);
    setError(null);
    void (async () => {
      try {
        const after = await plugin.auth.getHistoryFile(vaultId, commit.hash, path);
        // Unchanged files in all-files mode show content only.
        const before: FileAtCommit =
          changed && parent
            ? await plugin.auth.getHistoryFile(vaultId, parent, oldPath)
            : changed
              ? { type: "absent" }
              : after;
        setFiles({ before, after });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [plugin, vaultId, commit, path, oldPath, changed, parent]);

  if (error) return <p className="setting-item-description realtime-history-error">{error}</p>;
  if (!files) return <p className="setting-item-description">Loading…</p>;

  if (files.before.type === "binary" || files.after.type === "binary") {
    return (
      <BinaryPreview
        plugin={plugin}
        vaultId={vaultId}
        commitHash={commit.hash}
        parentHash={parent}
        path={path}
        before={files.before}
        after={files.after}
      />
    );
  }
  return <HistoryFileDiff path={path} before={files.before} after={files.after} />;
}

// ---------- rollback ----------

function RollbackBar({
  plugin,
  vaultId,
  hash,
  onDone,
}: {
  plugin: RealtimePlugin;
  vaultId: string;
  hash: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const plan = await plugin.auth.rollbackPreview(vaultId, hash);
      const confirmed = await openRollbackConfirm(plugin.app, plan);
      if (!confirmed) return;
      let pluginDbs: { plugin: string; name: string }[] = [];
      if (plan.pluginDbs.length > 0) {
        const picked = await openPluginDbPicker(plugin.app, plan.pluginDbs);
        if (picked === null) return;
        pluginDbs = picked;
      }
      const result = await plugin.auth.rollbackVault(vaultId, hash, pluginDbs);
      new Notice(
        `${PLUGIN_NAME}: rolled back — ${result.applied} updated, ${result.deleted} deleted` +
          (result.pluginDbsRolledBack ? `, ${result.pluginDbsRolledBack} database(s)` : "") +
          ".",
      );
      onDone();
    } catch (e) {
      new Notice(`${PLUGIN_NAME}: rollback failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="realtime-timeline-rollback">
      <span className="setting-item-description">
        Restore the whole vault to this commit. History is preserved — the restore is applied as a
        new change.
      </span>
      <button className="mod-warning" disabled={busy} onClick={() => void start()}>
        {busy ? "Working…" : "Roll back vault to this commit"}
      </button>
    </div>
  );
}

function openRollbackConfirm(app: App, plan: RollbackPlan): Promise<boolean> {
  return new Promise((resolve) => {
    new RollbackConfirmModal(app, plan, resolve).open();
  });
}

class RollbackConfirmModal extends Modal {
  private plan: RollbackPlan;
  private resolve: (ok: boolean) => void;
  private settled = false;

  constructor(app: App, plan: RollbackPlan, resolve: (ok: boolean) => void) {
    super(app);
    this.plan = plan;
    this.resolve = resolve;
  }

  private settle(ok: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(ok);
    this.close();
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("realtime-rollback-confirm");
    contentEl.createEl("h3", { text: "Roll back vault?" });

    const counts = new Map<string, number>();
    for (const c of this.plan.changes) counts.set(c.action, (counts.get(c.action) ?? 0) + 1);
    const summary =
      [
        counts.get("create") && `${counts.get("create")} created`,
        counts.get("modify") && `${counts.get("modify")} modified`,
        counts.get("delete") && `${counts.get("delete")} deleted (recoverable from trash)`,
        counts.get("restoreBlob") && `${counts.get("restoreBlob")} attachment(s) restored`,
      ]
        .filter(Boolean)
        .join(", ") || "No file changes";
    contentEl.createEl("p", { text: summary + "." });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "History is not rewritten: the rollback is recorded as a new commit and can itself be rolled back.",
    });

    if (this.plan.unrecoverableBinaries.length > 0) {
      const warn = contentEl.createDiv({ cls: "realtime-rollback-warning" });
      warn.createEl("strong", {
        text: `${this.plan.unrecoverableBinaries.length} attachment(s) cannot be restored (blob deleted):`,
      });
      const list = warn.createEl("ul");
      for (const b of this.plan.unrecoverableBinaries) {
        list.createEl("li", {
          text: b.path + (b.currentKept ? " — the current file will be kept" : ""),
        });
      }
    }

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.settle(false));
    const ok = actions.createEl("button", { text: "Roll back", cls: "mod-warning" });
    ok.addEventListener("click", () => this.settle(true));
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolve(false);
    }
    this.contentEl.empty();
  }
}

function openPluginDbPicker(
  app: App,
  dbs: PluginDbPlan[],
): Promise<{ plugin: string; name: string }[] | null> {
  return new Promise((resolve) => {
    new PluginDbPickerModal(app, dbs, resolve).open();
  });
}

class PluginDbPickerModal extends Modal {
  private dbs: PluginDbPlan[];
  private resolve: (picked: { plugin: string; name: string }[] | null) => void;
  private settled = false;
  private checked = new Set<string>();

  constructor(
    app: App,
    dbs: PluginDbPlan[],
    resolve: (picked: { plugin: string; name: string }[] | null) => void,
  ) {
    super(app);
    this.dbs = dbs;
    this.resolve = resolve;
  }

  private settle(picked: { plugin: string; name: string }[] | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(picked);
    this.close();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Roll back plugin databases?" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Plugin databases are not rolled back unless selected here.",
    });
    for (const db of this.dbs) {
      const key = `${db.plugin}/${db.name}`;
      const row = contentEl.createDiv({ cls: "realtime-rollback-db-row" });
      const label = row.createEl("label");
      const box = label.createEl("input", { type: "checkbox" });
      box.disabled = !db.rollbackable;
      box.addEventListener("change", () => {
        if (box.checked) this.checked.add(key);
        else this.checked.delete(key);
      });
      label.appendText(` ${key}`);
      if (!db.rollbackable) {
        row.createEl("div", {
          cls: "setting-item-description",
          text: db.reason ?? "not rollbackable",
        });
      }
    }
    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "Cancel rollback" });
    cancel.addEventListener("click", () => this.settle(null));
    const ok = actions.createEl("button", { text: "Continue", cls: "mod-cta" });
    ok.addEventListener("click", () =>
      this.settle(
        [...this.checked].map((key) => {
          const [plugin, ...rest] = key.split("/");
          return { plugin, name: rest.join("/") };
        }),
      ),
    );
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolve(null);
    }
    this.contentEl.empty();
  }
}
