import { App, Modal, Notice } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";
import type RealtimePlugin from "./main";
import type { TrashEntry, TrashKind } from "./VaultSync";
import { PLUGIN_NAME } from "./brand";

const KIND_LABELS: Record<TrashKind, string> = {
  text: "Note",
  canvas: "Canvas",
  base: "Base",
  binary: "Attachment",
  plugindb: "Database",
};

/** Open the trash browser modal. */
export function openTrashModal(plugin: RealtimePlugin): void {
  new TrashModal(plugin.app, plugin).open();
}

class TrashModal extends Modal {
  private plugin: RealtimePlugin;
  private root: Root | null = null;

  constructor(app: App, plugin: RealtimePlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.modalEl.addClass("realtime-trash-modal");
    this.root = createRoot(this.contentEl);
    this.root.render(<TrashView plugin={this.plugin} />);
  }

  onClose(): void {
    this.root?.unmount();
    this.root = null;
    this.contentEl.empty();
  }
}

function TrashView({ plugin }: { plugin: RealtimePlugin }) {
  const vaultSync = plugin.vaultSync;
  const [entries, setEntries] = useState<TrashEntry[]>(() => vaultSync?.listTrash() ?? []);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!vaultSync) return;
    const refresh = () => setEntries(vaultSync.listTrash());
    refresh();
    return vaultSync.observeTrash(refresh);
  }, [vaultSync]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((entry) => entry.path.toLowerCase().includes(q));
  }, [entries, query]);

  if (!vaultSync) {
    return (
      <>
        <h3>Trash</h3>
        <p className="setting-item-description">Connect to your vault to view deleted files.</p>
      </>
    );
  }

  return (
    <>
      <h3>Trash</h3>
      <p className="setting-item-description">
        Deleted files are kept here and can be restored to their original location or a new path.
        Permanently deleting an attachment reclaims its storage.
      </p>
      <input
        className="realtime-modal-input"
        type="text"
        placeholder="Filter by path…"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {filtered.length === 0 ? (
        <p className="setting-item-description">
          {entries.length === 0 ? "Trash is empty." : "No matches."}
        </p>
      ) : (
        <div className="realtime-trash-list">
          {filtered.map((entry) => (
            <TrashRow key={entry.id} plugin={plugin} entry={entry} />
          ))}
        </div>
      )}
    </>
  );
}

function TrashRow({ plugin, entry }: { plugin: RealtimePlugin; entry: TrashEntry }) {
  const [renaming, setRenaming] = useState(false);
  const [target, setTarget] = useState(entry.path);
  const [busy, setBusy] = useState(false);

  const restore = (path?: string) =>
    void (async () => {
      setBusy(true);
      try {
        if (!plugin.vaultSync) {
          new Notice(`${PLUGIN_NAME}: sync is not running.`);
          return;
        }
        await plugin.vaultSync.restoreTrashEntry(entry.id, path);
        new Notice(`${PLUGIN_NAME}: restored "${path?.trim() || entry.path}".`);
      } catch (e) {
        new Notice(`${PLUGIN_NAME}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    })();

  const purge = () =>
    void (async () => {
      if (!confirm(`Permanently delete "${entry.path}"? This cannot be undone.`)) return;
      setBusy(true);
      try {
        if (!plugin.vaultSync) {
          new Notice(`${PLUGIN_NAME}: sync is not running.`);
          return;
        }
        await plugin.vaultSync.permanentlyDeleteTrashEntry(entry.id);
        new Notice(`${PLUGIN_NAME}: permanently deleted "${entry.path}".`);
      } catch (e) {
        new Notice(`${PLUGIN_NAME}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    })();

  return (
    <div className="realtime-trash-row">
      <div className="realtime-trash-info">
        <div className="realtime-trash-path">{entry.path}</div>
        <div className="setting-item-description">
          {KIND_LABELS[entry.kind] ?? entry.kind} · deleted {formatWhen(entry.deletedAt)}
        </div>
        {renaming ? (
          <div className="realtime-actions realtime-trash-rename">
            <input
              className="realtime-modal-input"
              type="text"
              value={target}
              onChange={(event) => setTarget(event.currentTarget.value)}
              placeholder="New path"
            />
            <button
              className="mod-cta"
              disabled={busy || !target.trim()}
              onClick={() => restore(target)}
            >
              Restore here
            </button>
            <button disabled={busy} onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </div>
        ) : null}
      </div>
      {!renaming ? (
        <div className="realtime-trash-actions">
          <button className="mod-cta" disabled={busy} onClick={() => restore()}>
            Restore
          </button>
          {entry.kind !== "plugindb" ? (
            <button
              disabled={busy}
              onClick={() => {
                setTarget(entry.path);
                setRenaming(true);
              }}
            >
              Restore as…
            </button>
          ) : null}
          <button className="mod-warning" disabled={busy} onClick={purge}>
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

function formatWhen(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}
