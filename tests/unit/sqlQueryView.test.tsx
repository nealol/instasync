import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { SqlQueryPanel } from "../../src/sql/SqlQueryView";
import { waitFor } from "../support/util";

vi.mock("obsidian", () => ({
  ItemView: class {},
}));

describe("SQL query view", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    root?.unmount();
    container?.remove();
    root = null;
    container = null;
  });

  it("executes the editor query and renders returned rows as a Bases table", async () => {
    const debugExecute = vi.fn(async () => [
      { name: "tasks", type: "table" },
      { name: "sqlite_master", type: "table" },
    ]);
    const plugin = {
      sqlApi: {
        debugDatabases: () => [{ pluginId: "tasks-plugin", name: "main", state: "live" }],
        debugExecute,
      },
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(<SqlQueryPanel plugin={plugin as any} />));

    await waitFor(
      () => !(container!.querySelector("button") as HTMLButtonElement | null)?.disabled,
      { label: "database selection" },
    );
    (container.querySelector("button") as HTMLButtonElement).click();

    await waitFor(() => container!.querySelectorAll(".bases-table tbody tr").length === 2, {
      label: "query results",
    });

    expect(debugExecute).toHaveBeenCalledWith(
      "tasks-plugin",
      "main",
      expect.stringContaining("sqlite_master"),
    );
    expect(container.querySelector(".bases-view")).not.toBeNull();
    expect(container.querySelector(".bases-table")?.textContent).toContain("tasks");
  });
});
