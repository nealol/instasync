import { useEffect, useState } from "react";
import * as Y from "yjs";

export type SharedNoteState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "revoked"; title?: string }
  | { status: "ready"; title: string; path: string; content: string };

interface ViewResponse {
  title: string;
  path: string;
  updateB64: string;
  updatedAt: number;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Loads a publicly shared note and keeps it live: the snapshot seeds a local
 * Y.Doc, then the SSE stream delivers incremental Yjs updates which re-render
 * via the Y.Text observer. The EventSource auto-reconnects; updates are
 * idempotent CRDT merges, so replays after a reconnect are harmless.
 */
export function useSharedNote(shareId: string): SharedNoteState {
  const [state, setState] = useState<SharedNoteState>({ status: "loading" });

  useEffect(() => {
    const doc = new Y.Doc();
    let source: EventSource | null = null;
    let cancelled = false;
    let title = "";
    let path = "";

    const render = () => {
      if (cancelled) return;
      setState({ status: "ready", title, path, content: doc.getText("contents").toString() });
    };

    (async () => {
      const res = await fetch(`/api/view/${encodeURIComponent(shareId)}`);
      if (!res.ok) {
        if (!cancelled) setState({ status: "not-found" });
        return;
      }
      const body = (await res.json()) as ViewResponse;
      title = body.title;
      path = body.path;
      Y.applyUpdate(doc, b64ToBytes(body.updateB64));
      doc.getText("contents").observe(render);
      render();

      source = new EventSource(`/api/view/${encodeURIComponent(shareId)}/events`);
      source.addEventListener("update", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { update: string };
        Y.applyUpdate(doc, b64ToBytes(data.update));
      });
      source.addEventListener("revoked", () => {
        source?.close();
        if (!cancelled) setState({ status: "revoked", title });
      });
    })().catch(() => {
      if (!cancelled) setState({ status: "not-found" });
    });

    return () => {
      cancelled = true;
      source?.close();
      doc.destroy();
    };
  }, [shareId]);

  return state;
}
