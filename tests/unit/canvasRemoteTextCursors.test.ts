import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { mountCanvasRemoteTextCursors } from "../../src/editor/CanvasRemoteTextCursors";

function setRemote(awareness: Awareness, clientId: number, ytext: Y.Text, nodeId: string) {
  const anchor = Y.createRelativePositionFromTypeIndex(ytext, 1);
  const head = Y.createRelativePositionFromTypeIndex(ytext, 3);
  awareness.getStates().set(clientId, {
    user: { name: "Remote", color: "#ff0000" },
    cursor: { anchor, head },
    canvasPresence: { version: 1, sequence: 1, editingNodeId: nodeId },
  });
  (awareness as any).emit("change", [{ added: [clientId], updated: [], removed: [] }, "test"]);
}

describe("mountCanvasRemoteTextCursors", () => {
  it("renders only cursors scoped to the active Canvas node and cleans up", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("card");
    ytext.insert(0, "hello");
    const awareness = new Awareness(ydoc);
    const host = document.createElement("div");
    document.body.append(host);
    const view = new EditorView({ state: EditorState.create({ doc: "hello" }), parent: host });
    const cleanup = mountCanvasRemoteTextCursors(view, ytext, awareness, "n1");

    setRemote(awareness, 42, ytext, "other");
    expect(host.querySelector(".cm-ySelectionCaret")).toBeNull();
    setRemote(awareness, 42, ytext, "n1");
    expect(host.querySelector(".cm-ySelectionCaret")).not.toBeNull();

    cleanup();
    expect(host.querySelector(".cm-ySelectionCaret")).toBeNull();
    expect(awareness.getLocalState()?.cursor).toBeNull();
    view.destroy();
    awareness.destroy();
    ydoc.destroy();
    host.remove();
  });
});
