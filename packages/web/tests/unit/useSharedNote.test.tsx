// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSharedNote, type SharedNoteState } from "../../src/useSharedNote";

function documentWithText(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("contents").insert(0, text);
  return doc;
}

function fullUpdate(doc: Y.Doc): string {
  return btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc)));
}

class FakeEventSource {
  static latest: FakeEventSource | null = null;
  private listeners = new Map<string, (event: MessageEvent) => void>();

  constructor(readonly url: string) {
    FakeEventSource.latest = this;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(type, listener as (event: MessageEvent) => void);
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }

  close(): void {}
}

function Probe({ onState }: { onState: (state: SharedNoteState) => void }) {
  onState(useSharedNote("share"));
  return null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.latest = null;
  document.body.replaceChildren();
});

describe("useSharedNote", () => {
  it("applies a same-epoch stream snapshot containing an intervening edit", async () => {
    const shared = documentWithText("before");
    const initial = fullUpdate(shared);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          title: "Note",
          path: "note.md",
          epoch: 4,
          updateB64: initial,
          updatedAt: 0,
        }),
      })),
    );
    vi.stubGlobal("EventSource", FakeEventSource);

    let state: SharedNoteState = { status: "loading" };
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => {
      root.render(<Probe onState={(next) => (state = next)} />);
    });
    expect(state).toMatchObject({ status: "ready", content: "before" });

    shared.getText("contents").insert(6, " and after");
    await act(async () => {
      FakeEventSource.latest?.emit("snapshot", {
        epoch: 4,
        update: fullUpdate(shared),
      });
    });
    expect(state).toMatchObject({ status: "ready", content: "before and after" });

    await act(async () => root.unmount());
    shared.destroy();
  });
});
