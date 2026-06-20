import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";
import { File, FileDiff } from "@pierre/diffs/react";
import { parseDiffFromFile } from "@pierre/diffs";
import type RealtimePlugin from "../main";
import type { HistoryCommit, FileAtCommit } from "./types";
import { openTimelineModal } from "./TimelineModal";

export const FILE_HISTORY_VIEW_TYPE = "realtime-file-history";

/** Right-sidebar leaf showing the git history of the active file. */
export class FileHistoryView extends ItemView {
  private plugin: RealtimePlugin;
  private root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: RealtimePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return FILE_HISTORY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "File history";
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("realtime-history-view");
    this.root = createRoot(this.contentEl);
    this.root.render(<FileHistoryPanel plugin={this.plugin} />);
  }

  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
    this.contentEl.empty();
  }
}

function FileHistoryPanel({ plugin }: { plugin: RealtimePlugin }) {
  const [path, setPath] = useState<string | null>(
    () => plugin.app.workspace.getActiveFile()?.path ?? null,
  );
  const [commits, setCommits] = useState<HistoryCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vaultId = plugin.settings.activeVaultId;

  useEffect(() => {
    const ref = plugin.app.workspace.on("file-open", (file: TFile | null) => {
      setPath(file?.path ?? null);
    });
    return () => plugin.app.workspace.offref(ref);
  }, [plugin]);

  const load = useCallback(
    async (before?: string) => {
      if (!vaultId || !path) return;
      setLoading(true);
      setError(null);
      try {
        const page = await plugin.auth.listHistoryCommits(vaultId, {
          limit: 30,
          path,
          before,
        });
        setCommits((prev) => (before ? [...prev, ...page.commits] : page.commits));
        setHasMore(page.hasMore);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [plugin, vaultId, path],
  );

  useEffect(() => {
    setCommits([]);
    setHasMore(false);
    void load();
  }, [load]);

  if (!vaultId) {
    return <p className="setting-item-description">Connect to a vault to view file history.</p>;
  }
  if (!path) {
    return <p className="setting-item-description">Open a file to view its history.</p>;
  }

  return (
    <div className="realtime-history-panel">
      <div className="realtime-history-header">
        <h4>{path}</h4>
      </div>
      {error && <p className="setting-item-description realtime-history-error">{error}</p>}
      {!error && commits.length === 0 && !loading && (
        <p className="setting-item-description">No history for this file yet.</p>
      )}
      <div className="realtime-history-list">
        {commits.map((commit) => (
          <CommitRow
            key={commit.hash}
            plugin={plugin}
            vaultId={vaultId}
            path={path}
            commit={commit}
          />
        ))}
      </div>
      {hasMore && (
        <button disabled={loading} onClick={() => void load(commits[commits.length - 1]?.hash)}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
      <div className="realtime-history-footer">
        <button className="mod-cta" onClick={() => openTimelineModal(plugin)}>
          Open vault timeline
        </button>
      </div>
    </div>
  );
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function CommitRow({
  plugin,
  vaultId,
  path,
  commit,
}: {
  plugin: RealtimePlugin;
  vaultId: string;
  path: string;
  commit: HistoryCommit;
}) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<{ before: FileAtCommit; after: FileAtCommit } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded || files) return;
    void (async () => {
      try {
        const after = await plugin.auth.getHistoryFile(vaultId, commit.hash, path);
        const parent = commit.parents[0];
        const before: FileAtCommit = parent
          ? await plugin.auth.getHistoryFile(vaultId, parent, path)
          : { type: "absent" };
        setFiles({ before, after });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [expanded, files, plugin, vaultId, commit, path]);

  const author = commit.cursorName
    ? `${commit.cursorName} (for ${commit.onBehalfOf ?? commit.authorName})`
    : commit.authorName;

  return (
    <div className="realtime-history-row">
      <div className="realtime-history-row-head" onClick={() => setExpanded((v) => !v)}>
        <span className="realtime-history-subject">{commit.subject}</span>
        <span className="realtime-history-meta">
          {author} · {relativeTime(commit.timestampMs)} · {commit.shortHash}
        </span>
      </div>
      {expanded && error && (
        <p className="setting-item-description realtime-history-error">{error}</p>
      )}
      {expanded && files && (
        <HistoryFileDiff path={path} before={files.before} after={files.after} unified />
      )}
    </div>
  );
}

export function HistoryFileDiff({
  path,
  before,
  after,
  unified,
  showUnchangedContents,
}: {
  path: string;
  before: FileAtCommit;
  after: FileAtCommit;
  unified?: boolean;
  showUnchangedContents?: boolean;
}) {
  if (before.type === "binary" || after.type === "binary") {
    return (
      <p className="setting-item-description">
        Binary file — use the vault timeline for a preview.
      </p>
    );
  }
  const beforeText = before.type === "text" ? before.content : "";
  const afterText = after.type === "text" ? after.content : "";
  const lang =
    after.type === "text" ? after.lang : before.type === "text" ? before.lang : "markdown";
  if (beforeText === afterText) {
    if (showUnchangedContents) {
      if (after.type === "absent") {
        return <p className="setting-item-description">File not present at this commit.</p>;
      }
      return (
        <>
          <p className="realtime-history-unchanged-label">
            No changes to this file in this commit.
          </p>
          <div className="realtime-history-diff">
            <File
              file={{ name: path, contents: afterText, lang }}
              disableWorkerPool
              options={{
                overflow: "wrap",
                themeType: "system",
                disableVirtualizationBuffers: true,
              }}
            />
          </div>
        </>
      );
    }
    return <p className="setting-item-description">No changes to this file in this commit.</p>;
  }
  const fileDiff = parseDiffFromFile(
    { name: `${path} (before)`, contents: beforeText, lang },
    { name: `${path} (after)`, contents: afterText, lang },
  );
  return (
    <div className="realtime-history-diff">
      <FileDiff
        fileDiff={fileDiff}
        disableWorkerPool
        options={{
          diffStyle: unified ? "unified" : "split",
          overflow: "wrap",
          themeType: "system",
          lineDiffType: "word",
          disableVirtualizationBuffers: true,
        }}
      />
    </div>
  );
}
