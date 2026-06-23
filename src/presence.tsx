// Shared presence UI helpers: avatar stacks and canvas cursor overlays.
//
// Both markdown editors and canvas views use the same Yjs awareness transport
// (per-document `awareness.setLocalStateField("user", ...)`), so this module
// provides the rendering and lifecycle glue that each mount point needs.

import { createElement, type ReactElement, type CSSProperties } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Awareness } from "y-protocols/awareness";

// ---------- types ----------

export interface AwarenessUser {
  name?: string;
  color?: string;
  colorLight?: string;
  avatarUrl?: string | null;
}

export interface PresenceEntry {
  clientId: number;
  name: string;
  color: string;
  avatarUrl: string | null;
  isLocal: boolean;
}

export interface CanvasCursorState {
  x: number;
  y: number;
}

// ---------- helpers ----------

/** Derive 1–2 character initials from a display name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Collect presence entries from awareness states, filtered by `viewing.kind`.
 * Includes both local and remote clients whose awareness has `state.user` and
 * `state.viewing.kind === kind`. Sorts local client first, then ascending
 * `clientId` for deterministic z-order and tests.
 */
export function collectPresenceEntries(
  states: Map<number, unknown>,
  localClientId: number,
  kind: "markdown" | "canvas",
): PresenceEntry[] {
  const entries: PresenceEntry[] = [];
  states.forEach((rawState, clientId) => {
    if (!rawState || typeof rawState !== "object") return;
    const state = rawState as Record<string, unknown>;
    const user = state.user as AwarenessUser | undefined;
    if (!user) return;
    const viewing = state.viewing as { kind?: string } | undefined;
    if (!viewing || viewing.kind !== kind) return;
    entries.push({
      clientId,
      name: user.name ?? "Anonymous",
      color: user.color ?? "#30bced",
      avatarUrl: user.avatarUrl ?? null,
      isLocal: clientId === localClientId,
    });
  });
  entries.sort((a, b) => {
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    return a.clientId - b.clientId;
  });
  return entries;
}

// ---------- viewing reference counting ----------

const viewingRefs = new WeakMap<Awareness, Map<string, number>>();

/**
 * Mark this awareness as "viewing" a given kind (markdown or canvas).
 * Reference-counted per `(Awareness, kind)`: the first mark sets the
 * `viewing` awareness field; the last cleanup clears it (only if the current
 * `viewing.kind` still matches). This prevents one of two open editors for the
 * same note from clearing presence while another remains open.
 */
export function markViewing(awareness: Awareness, kind: "markdown" | "canvas"): () => void {
  let byKind = viewingRefs.get(awareness);
  if (!byKind) {
    byKind = new Map();
    viewingRefs.set(awareness, byKind);
  }
  const count = byKind.get(kind) ?? 0;
  byKind.set(kind, count + 1);
  if (count === 0) {
    awareness.setLocalStateField("viewing", { kind });
  }
  return () => {
    const current = byKind.get(kind) ?? 0;
    if (current <= 1) {
      byKind.delete(kind);
      const localState = awareness.getLocalState();
      const viewing = localState?.viewing as { kind?: string } | undefined;
      if (viewing?.kind === kind) {
        awareness.setLocalStateField("viewing", null);
      }
    } else {
      byKind.set(kind, current - 1);
    }
  };
}

// ---------- canvas cursor awareness ----------

/** Publish the local pointer position (or null to clear) into awareness. */
export function setCanvasCursor(awareness: Awareness, cursor: CanvasCursorState | null): void {
  awareness.setLocalStateField("canvasCursor", cursor);
}

// ---------- React avatar stack ----------

/**
 * Render a stack of avatar bubbles. Returns `null` for zero entries so the
 * mount point can skip the DOM entirely. Each bubble has a CSS variable
 * `--realtime-presence-color` set to the device's cursor color and an offset
 * border via `::after`.
 */
export function PresenceAvatarStack({ entries }: { entries: PresenceEntry[] }): ReactElement | null {
  if (entries.length === 0) return null;
  return createElement(
    "div",
    { className: "realtime-presence-stack" },
    entries.map((entry) =>
      createElement(
        "div",
        {
          key: entry.clientId,
          className: "realtime-presence-avatar-wrap",
          style: { "--realtime-presence-color": entry.color } as CSSProperties,
          title: `${entry.isLocal ? "You: " : ""}${entry.name}`,
        },
        entry.avatarUrl
          ? createElement("img", {
              className: "realtime-presence-avatar",
              src: entry.avatarUrl,
              alt: entry.name,
            })
          : createElement(
              "div",
              { className: "realtime-presence-avatar-fallback" },
              initials(entry.name),
            ),
      ),
    ),
  );
}

// ---------- mount helpers ----------

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

/**
 * Mount a React avatar stack into `host`, subscribed to `awareness` changes.
 * Returns a cleanup function that unsubscribes, unmounts, removes the child
 * div, and releases the viewing mark.
 */
export function mountPresenceStack(
  host: HTMLElement,
  awareness: Awareness,
  kind: "markdown" | "canvas",
  className?: string,
): () => void {
  const container = document.createElement("div");
  if (className) container.className = className;
  host.appendChild(container);
  const root = createRoot(container);

  const render = () => {
    const entries = collectPresenceEntries(
      awareness.getStates(),
      awareness.doc.clientID,
      kind,
    );
    root.render(PresenceAvatarStack({ entries }));
  };

  const listener = () => render();
  awareness.on("change", listener);
  const releaseViewing = markViewing(awareness, kind);
  render();

  return () => {
    awareness.off("change", listener);
    releaseViewing();
    root.unmount();
    container.remove();
  };
}

/**
 * Mount a canvas cursor overlay into `host`. Subscribes to awareness changes
 * and renders remote cursor markers for states with `state.canvasCursor` and
 * `state.user`. Publishes local pointer coordinates relative to
 * `host.getBoundingClientRect()` on `pointermove` (throttled with rAF), and
 * clears on `pointerleave`, `window.blur`, and hidden `visibilitychange`.
 */
export function mountCanvasCursorOverlay(host: HTMLElement, awareness: Awareness): () => void {
  const layer = document.createElement("div");
  layer.className = "realtime-canvas-presence-layer";
  host.appendChild(layer);
  const root = createRoot(layer);

  const render = () => {
    const localId = awareness.doc.clientID;
    const markers: Array<{
      key: number;
      name: string;
      color: string;
      x: number;
      y: number;
    }> = [];
    awareness.getStates().forEach((rawState, clientId) => {
      if (clientId === localId) return;
      if (!rawState || typeof rawState !== "object") return;
      const state = rawState as Record<string, unknown>;
      const user = state.user as AwarenessUser | undefined;
      if (!user) return;
      const cursor = state.canvasCursor as CanvasCursorState | null | undefined;
      if (!cursor || typeof cursor.x !== "number" || typeof cursor.y !== "number") return;
      markers.push({
        key: clientId,
        name: user.name ?? "Anonymous",
        color: user.color ?? "#30bced",
        x: cursor.x,
        y: cursor.y,
      });
    });
    root.render(
      createElement(
        "div",
        null,
        markers.map((m) =>
          createElement(
            "div",
            {
              key: m.key,
              className: "realtime-canvas-cursor",
              style: {
                "--realtime-presence-color": m.color,
                "--realtime-canvas-x": `${m.x}px`,
                "--realtime-canvas-y": `${m.y}px`,
              } as CSSProperties,
            },
            createElement("div", { className: "realtime-canvas-cursor-dot" }),
            createElement("div", { className: "realtime-canvas-cursor-label" }, m.name),
          ),
        ),
      ),
    );
  };

  const listener = () => render();
  awareness.on("change", listener);
  render();

  let rafId: number | null = null;
  let pending: { x: number; y: number } | null = null;

  const onPointerMove = (event: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    pending = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (pending) {
          setCanvasCursor(awareness, pending);
          pending = null;
        }
      });
    }
  };

  const clearCursor = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    pending = null;
    setCanvasCursor(awareness, null);
  };

  const onPointerLeave = () => clearCursor();
  const onBlur = () => clearCursor();
  const onVisibilityChange = () => {
    if (document.hidden) clearCursor();
  };

  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerleave", onPointerLeave);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    awareness.off("change", listener);
    host.removeEventListener("pointermove", onPointerMove);
    host.removeEventListener("pointerleave", onPointerLeave);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (rafId !== null) cancelAnimationFrame(rafId);
    setCanvasCursor(awareness, null);
    root.unmount();
    layer.remove();
  };
}
