import { ItemView, WorkspaceLeaf } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import type RealtimePlugin from "../main";
import type { DebugDatabase } from "../pluginDb/api";
import type { SqlValue } from "../pluginDb/types";

export const SQL_QUERY_VIEW_TYPE = "realtime-sql-query";

const DEFAULT_QUERY = `SELECT name, type
FROM sqlite_master
ORDER BY type, name;`;

export class SqlQueryView extends ItemView {
  private plugin: RealtimePlugin;
  private root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: RealtimePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SQL_QUERY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "SQL query";
  }

  getIcon(): string {
    return "database";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("realtime-sql-query-view");
    this.root = createRoot(this.contentEl);
    this.root.render(<SqlQueryPanel plugin={this.plugin} />);
  }

  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
    this.contentEl.empty();
  }
}

function databaseKey(database: Pick<DebugDatabase, "pluginId" | "name">): string {
  return `${database.pluginId}/${database.name}`;
}

export function SqlQueryPanel({ plugin }: { plugin: RealtimePlugin }) {
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [databases, setDatabases] = useState<DebugDatabase[]>(() =>
    plugin.sqlApi.debugDatabases(),
  );
  const [selected, setSelected] = useState("");
  const [rows, setRows] = useState<Record<string, SqlValue>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const refreshDatabases = useCallback(() => {
    const next = plugin.sqlApi.debugDatabases();
    setDatabases(next);
    setSelected((current) => {
      if (next.some((database) => databaseKey(database) === current)) return current;
      return next[0] ? databaseKey(next[0]) : "";
    });
  }, [plugin]);

  useEffect(() => {
    refreshDatabases();
    const timer = window.setInterval(refreshDatabases, 1_000);
    return () => window.clearInterval(timer);
  }, [refreshDatabases]);

  const selectedDatabase = databases.find((database) => databaseKey(database) === selected);

  const run = useCallback(async () => {
    if (!selectedDatabase || !query.trim() || running) return;
    setRunning(true);
    setError(null);
    try {
      setRows(
        await plugin.sqlApi.debugExecute(
          selectedDatabase.pluginId,
          selectedDatabase.name,
          query,
        ),
      );
      refreshDatabases();
    } catch (cause) {
      setRows(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  }, [plugin, query, refreshDatabases, running, selectedDatabase]);

  const onQueryKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void run();
    }
  };

  return (
    <div className="bases-view" style={panelStyle}>
      <div style={toolbarStyle}>
        <label style={databaseLabelStyle}>
          <span style={labelTextStyle}>Database</span>
          <select
            value={selected}
            disabled={databases.length === 0 || running}
            onChange={(event) => {
              setSelected(event.currentTarget.value);
              setRows(null);
              setError(null);
            }}
          >
            {databases.map((database) => (
              <option key={databaseKey(database)} value={databaseKey(database)}>
                {database.pluginId}/{database.name} ({database.state})
              </option>
            ))}
          </select>
        </label>
        <button
          className="mod-cta"
          disabled={!selectedDatabase || !query.trim() || running}
          onClick={() => void run()}
        >
          {running ? "Running…" : "Run"}
        </button>
      </div>

      <textarea
        aria-label="SQL query"
        value={query}
        spellCheck={false}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={onQueryKeyDown}
        style={queryStyle}
      />
      <div className="setting-item-description">
        {databases.length === 0
          ? "No local plugin databases are currently open."
          : "Run with ⌘↵ on macOS or Ctrl+Enter on other platforms. This debug view can access every table, including SQLite and cr-sqlite internals."}
      </div>

      {error && (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      )}
      {rows && <QueryResults rows={rows} />}
    </div>
  );
}

function QueryResults({ rows }: { rows: Record<string, SqlValue>[] }) {
  const columns = useMemo(() => {
    const seen = new Set<string>();
    for (const row of rows) {
      for (const column of Object.keys(row)) seen.add(column);
    }
    return [...seen];
  }, [rows]);

  if (rows.length === 0) {
    return <div style={emptyStyle}>Query completed. No rows returned.</div>;
  }

  return (
    <div style={resultsStyle}>
      <table className="bases-table" style={tableStyle}>
        <thead className="bases-thead">
          <tr className="bases-row">
            {columns.map((column) => (
              <th className="bases-cell" key={column} style={headerCellStyle}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bases-tbody">
          {rows.map((row, rowIndex) => (
            <tr className="bases-row" key={rowIndex}>
              {columns.map((column) => (
                <td className="bases-cell" key={column} style={cellStyle}>
                  {formatValue(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatValue(value: SqlValue | undefined): string {
  if (value === undefined) return "";
  if (value === null) return "NULL";
  if (value instanceof Uint8Array) return `<BLOB ${value.byteLength} bytes>`;
  return String(value);
}

const panelStyle: CSSProperties = {
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: "var(--size-4-3)",
  height: "100%",
  padding: "var(--size-4-4)",
};

const toolbarStyle: CSSProperties = {
  alignItems: "end",
  display: "flex",
  gap: "var(--size-4-3)",
};

const databaseLabelStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: "var(--size-2-1)",
  minWidth: 0,
};

const labelTextStyle: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: "var(--font-ui-smaller)",
  fontWeight: "var(--font-semibold)",
};

const queryStyle: CSSProperties = {
  boxSizing: "border-box",
  fontFamily: "var(--font-monospace)",
  fontSize: "var(--font-ui-small)",
  minHeight: "9em",
  resize: "vertical",
  width: "100%",
};

const resultsStyle: CSSProperties = {
  border: "1px solid var(--background-modifier-border)",
  borderRadius: "var(--radius-s)",
  flex: 1,
  minHeight: 0,
  overflow: "auto",
};

const tableStyle: CSSProperties = {
  borderCollapse: "separate",
  borderSpacing: 0,
  fontSize: "var(--font-ui-small)",
  width: "100%",
};

const sharedCellStyle: CSSProperties = {
  borderBottom: "1px solid var(--background-modifier-border)",
  borderRight: "1px solid var(--background-modifier-border)",
  padding: "var(--size-2-2) var(--size-4-2)",
  textAlign: "left",
  verticalAlign: "top",
  whiteSpace: "pre-wrap",
};

const headerCellStyle: CSSProperties = {
  ...sharedCellStyle,
  background: "var(--background-secondary)",
  color: "var(--text-muted)",
  fontWeight: "var(--font-semibold)",
  position: "sticky",
  top: 0,
  zIndex: 1,
};

const cellStyle: CSSProperties = {
  ...sharedCellStyle,
  background: "var(--background-primary)",
  fontFamily: "var(--font-monospace)",
};

const emptyStyle: CSSProperties = {
  border: "1px solid var(--background-modifier-border)",
  borderRadius: "var(--radius-s)",
  color: "var(--text-muted)",
  padding: "var(--size-4-4)",
};

const errorStyle: CSSProperties = {
  background: "rgba(var(--color-red-rgb), 0.12)",
  border: "1px solid var(--color-red)",
  borderRadius: "var(--radius-s)",
  color: "var(--text-error)",
  padding: "var(--size-4-3)",
};
