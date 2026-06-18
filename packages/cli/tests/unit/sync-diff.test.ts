import { describe, expect, it } from "vitest";
import { classifyStatus, hashText, normalizeStructured, type RemoteEntry } from "../../src/sync";
import type { FileKind, SyncFileState } from "../../src/config";

const snapEntry = (kind: FileKind, hash: string): SyncFileState => ({
  kind,
  hash,
  size: 1,
  mtimeMs: 1,
});

describe("classifyStatus", () => {
  it("reports nothing when all three sides agree", () => {
    const h = hashText("hello");
    const entries = classifyStatus(
      new Map([["a.md", { kind: "note", hash: h }]]),
      { "a.md": snapEntry("note", h) },
      new Map<string, RemoteEntry>([["a.md", { kind: "note" }]]),
    );
    expect(entries).toEqual([]);
  });

  it("classifies local add/modify/delete against the snapshot", () => {
    const h = hashText("old");
    const entries = classifyStatus(
      new Map([
        ["new.md", { kind: "note" as const, hash: hashText("x") }],
        ["mod.md", { kind: "note" as const, hash: hashText("changed") }],
      ]),
      { "mod.md": snapEntry("note", h), "gone.md": snapEntry("note", h) },
      new Map<string, RemoteEntry>([
        ["mod.md", { kind: "note" }],
        ["gone.md", { kind: "note" }],
      ]),
    );
    expect(entries).toEqual([
      { path: "gone.md", kind: "note", local: "deleted" },
      { path: "mod.md", kind: "note", local: "modified" },
      { path: "new.md", kind: "note", local: "added" },
    ]);
  });

  it("classifies remote add/delete and attachment hash modification", () => {
    const h = hashText("bytes");
    const entries = classifyStatus(
      new Map([["pic.png", { kind: "attachment" as const, hash: h }]]),
      { "pic.png": snapEntry("attachment", h), "old.md": snapEntry("note", h) },
      new Map<string, RemoteEntry>([
        ["pic.png", { kind: "attachment", hash: "different" }],
        ["fresh.md", { kind: "note" }],
      ]),
    );
    expect(entries).toEqual([
      { path: "fresh.md", kind: "note", remote: "added" },
      { path: "old.md", kind: "note", local: "deleted", remote: "deleted" },
      { path: "pic.png", kind: "attachment", remote: "modified" },
    ]);
  });

  it("flags both sides for a conflict candidate", () => {
    const entries = classifyStatus(
      new Map([["a.png", { kind: "attachment" as const, hash: "local" }]]),
      { "a.png": snapEntry("attachment", "synced") },
      new Map<string, RemoteEntry>([["a.png", { kind: "attachment", hash: "remote" }]]),
    );
    expect(entries).toEqual([
      { path: "a.png", kind: "attachment", local: "modified", remote: "modified" },
    ]);
  });
});

describe("normalizeStructured", () => {
  it("ignores formatting differences", () => {
    expect(normalizeStructured('{\n\t"a": 1\n}\n')).toBe(normalizeStructured('{"a":1}'));
  });

  it("passes through invalid JSON unchanged", () => {
    expect(normalizeStructured("not json")).toBe("not json");
  });
});
