import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  collectPresenceEntries,
  markViewing,
  setCanvasCursor,
  readCanvasViewport,
  PresenceAvatarStack,
  initials,
  type PresenceEntry,
} from "../../src/presence";

function makeAwareness(): Awareness {
  const doc = new Y.Doc();
  return new Awareness(doc);
}

function set_user(aw: Awareness, user: Record<string, unknown>): void {
  aw.setLocalStateField("user", user);
}

describe("initials", () => {
  it("returns ? for empty string", () => {
    expect(initials("")).toBe("?");
  });
  it("returns first two chars for single word", () => {
    expect(initials("Alice")).toBe("AL");
  });
  it("returns first+last initials for multi-word", () => {
    expect(initials("Alice Bob")).toBe("AB");
    expect(initials("Alice Bob Charlie")).toBe("AC");
  });
});

describe("collectPresenceEntries", () => {
  it("filters by viewing.kind and includes local + remote, sorted local-first", () => {
    const aw = makeAwareness();
    const localId = aw.doc.clientID;

    // Local: viewing markdown
    set_user(aw, { name: "Local", color: "#ff0000", avatarUrl: "https://x/l.png" });
    aw.setLocalStateField("viewing", { kind: "markdown" });

    // Remote 1: viewing markdown
    const states = new Map<number, unknown>(aw.getStates());
    const remote1Id = localId + 1;
    const remote2Id = localId + 2;
    states.set(remote1Id, {
      user: { name: "Remote1", color: "#00ff00", avatarUrl: null },
      viewing: { kind: "markdown" },
    });
    // Remote 2: viewing canvas (should be filtered out for markdown)
    states.set(remote2Id, {
      user: { name: "Remote2", color: "#0000ff", avatarUrl: "https://x/r2.png" },
      viewing: { kind: "canvas" },
    });
    // Remote 3: no viewing field
    states.set(localId + 3, {
      user: { name: "NoViewing", color: "#aaaaaa" },
    });

    const entries = collectPresenceEntries(states, localId, "markdown");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.isLocal).toBe(true);
    expect(entries[0]!.name).toBe("Local");
    expect(entries[0]!.avatarUrl).toBe("https://x/l.png");
    expect(entries[1]!.isLocal).toBe(false);
    expect(entries[1]!.clientId).toBe(remote1Id);
    expect(entries[1]!.avatarUrl).toBeNull();
  });

  it("defaults missing name/color", () => {
    const aw = makeAwareness();
    const localId = aw.doc.clientID;
    const states = new Map<number, unknown>(aw.getStates());
    states.set(localId, { user: {}, viewing: { kind: "canvas" } });
    const entries = collectPresenceEntries(states, localId, "canvas");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("Anonymous");
    expect(entries[0]!.color).toBe("#30bced");
  });

  it("sorts remote clients by ascending clientId", () => {
    const aw = makeAwareness();
    const localId = aw.doc.clientID;
    const states = new Map<number, unknown>();
    states.set(localId + 5, { user: { name: "E" }, viewing: { kind: "markdown" } });
    states.set(localId + 2, { user: { name: "B" }, viewing: { kind: "markdown" } });
    states.set(localId, { user: { name: "Local" }, viewing: { kind: "markdown" } });
    const entries = collectPresenceEntries(states, localId, "markdown");
    expect(entries.map((e) => e.name)).toEqual(["Local", "B", "E"]);
  });
});

describe("markViewing", () => {
  it("sets viewing on first mark and clears on last release", () => {
    const aw = makeAwareness();
    const release1 = markViewing(aw, "markdown");
    expect(aw.getLocalState()?.viewing?.kind).toBe("markdown");
    const release2 = markViewing(aw, "markdown");
    // Still set after second mark
    expect(aw.getLocalState()?.viewing?.kind).toBe("markdown");
    // Release one — still set
    release1();
    expect(aw.getLocalState()?.viewing?.kind).toBe("markdown");
    // Release the last — cleared
    release2();
    expect(aw.getLocalState()?.viewing ?? null).toBeNull();
  });

  it("does not clear viewing if a different kind is current", () => {
    const aw = makeAwareness();
    const releaseMd = markViewing(aw, "markdown");
    // Simulate switching to canvas via another mark
    const releaseCanvas = markViewing(aw, "canvas");
    // Now viewing is canvas; releasing markdown should not clear it
    releaseMd();
    expect(aw.getLocalState()?.viewing?.kind).toBe("canvas");
    releaseCanvas();
    expect(aw.getLocalState()?.viewing ?? null).toBeNull();
  });
});

describe("setCanvasCursor", () => {
  it("writes { x, y, space:'canvas' } and clears to null without changing state.user", () => {
    const aw = makeAwareness();
    set_user(aw, { name: "Local", color: "#ff0000" });
    setCanvasCursor(aw, { x: 10, y: 20, space: "canvas" });
    expect(aw.getLocalState()?.canvasCursor).toEqual({ x: 10, y: 20, space: "canvas" });
    expect(aw.getLocalState()?.user?.name).toBe("Local");
    setCanvasCursor(aw, null);
    expect(aw.getLocalState()?.canvasCursor ?? null).toBeNull();
    expect(aw.getLocalState()?.user?.name).toBe("Local");
  });
});

describe("readCanvasViewport", () => {
  it("returns null for non-canvas objects", () => {
    expect(readCanvasViewport(null)).toBeNull();
    expect(readCanvasViewport({})).toBeNull();
    expect(readCanvasViewport({ scale: 1 })).toBeNull();
  });

  it("returns null when scale is missing, non-finite, or <= 0", () => {
    const base = makeCanvasLike();
    expect(readCanvasViewport({ ...base, scale: 0 })).toBeNull();
    expect(readCanvasViewport({ ...base, scale: NaN })).toBeNull();
    expect(readCanvasViewport({ ...base, scale: undefined })).toBeNull();
  });

  it("returns a viewport exposing posFromDom/domFromPos for a well-shaped canvas", () => {
    const c = makeCanvasLike();
    const vp = readCanvasViewport(c);
    expect(vp).not.toBeNull();
    // posFromDom: world = center.x + dom/scale
    expect(vp!.posFromDom({ x: 0, y: 0 })).toEqual({ x: 100, y: 50 });
    expect(vp!.posFromDom({ x: 50, y: 25 })).toEqual({ x: 150, y: 75 });
    // domFromPos is the inverse of posFromDom
    expect(vp!.domFromPos({ x: 150, y: 75 })).toEqual({ x: 50, y: 25 });
  });

  it("binds posFromDom/domFromPos so `this`-based methods work", () => {
    // Methods read `this.x/this.scale` like Obsidian's; without binding the
    // viewport wrappers would lose `this` and return NaN.
    const c = makeCanvasLikeThis();
    const vp = readCanvasViewport(c);
    expect(vp).not.toBeNull();
    expect(vp!.posFromDom({ x: 50, y: 25 })).toEqual({ x: 150, y: 75 });
    expect(vp!.domFromPos({ x: 150, y: 75 })).toEqual({ x: 50, y: 25 });
  });
});

function makeCanvasLike() {
  return {
    x: 100,
    y: 50,
    scale: 1,
    canvasRect: { cx: 400, cy: 300, left: 0, top: 0, width: 800, height: 600 },
    posFromDom: (p: { x: number; y: number }) => ({
      x: 100 + p.x / 1,
      y: 50 + p.y / 1,
    }),
    domFromPos: (p: { x: number; y: number }) => ({
      x: (p.x - 100) * 1,
      y: (p.y - 50) * 1,
    }),
  };
}

function makeCanvasLikeThis() {
  return {
    x: 100,
    y: 50,
    scale: 1,
    canvasRect: { cx: 400, cy: 300, left: 0, top: 0, width: 800, height: 600 },
    posFromDom: function (this: any, p: { x: number; y: number }) {
      return { x: this.x + p.x / this.scale, y: this.y + p.y / this.scale };
    },
    domFromPos: function (this: any, p: { x: number; y: number }) {
      return { x: (p.x - this.x) * this.scale, y: (p.y - this.y) * this.scale };
    },
  };
}

describe("PresenceAvatarStack", () => {
  it("renders nothing for zero entries", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    root.render(PresenceAvatarStack({ entries: [] }));
    // flushSync is not available in vitest jsdom; use act alternative
    container.remove();
    // The function returns null for zero entries
    const result = PresenceAvatarStack({ entries: [] });
    expect(result).toBeNull();
  });

  it("renders avatar wrappers with color CSS variable and img/fallback", () => {
    const entries: PresenceEntry[] = [
      {
        clientId: 1,
        name: "Alice",
        color: "#ff0000",
        avatarUrl: "https://example.com/a.png",
        isLocal: true,
      },
      {
        clientId: 2,
        name: "Bob",
        color: "#00ff00",
        avatarUrl: null,
        isLocal: false,
      },
    ];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => {
      root.render(PresenceAvatarStack({ entries }));
    });
    container.querySelectorAll;
    const wraps = container.querySelectorAll(".realtime-presence-avatar-wrap");
    expect(wraps.length).toBe(2);
    const wrap0 = wraps[0] as HTMLElement;
    expect(wrap0.style.getPropertyValue("--realtime-presence-color")).toBe("#ff0000");
    expect(wrap0.querySelector("img")?.getAttribute("src")).toBe("https://example.com/a.png");
    const wrap1 = wraps[1] as HTMLElement;
    expect(wrap1.style.getPropertyValue("--realtime-presence-color")).toBe("#00ff00");
    expect(wrap1.querySelector(".realtime-presence-avatar-fallback")?.textContent).toBe("BO");
    root.unmount();
    container.remove();
  });
});
