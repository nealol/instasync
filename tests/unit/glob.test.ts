import { describe, it, expect } from "vitest";
import { parseGlobs, matchesAnyGlob } from "../../src/glob";

describe("glob", () => {
  it("parses comma-separated lists, trimming and dropping empties", () => {
    expect(parseGlobs(" *.tmp , private/** ,, ")).toEqual(["*.tmp", "private/**"]);
    expect(parseGlobs("")).toEqual([]);
  });

  it("matches * within a single path segment only", () => {
    expect(matchesAnyGlob("a.tmp", ["*.tmp"])).toBe(true);
    expect(matchesAnyGlob("sub/a.tmp", ["*.tmp"])).toBe(false);
    expect(matchesAnyGlob("note.md", ["*.tmp"])).toBe(false);
  });

  it("matches ** across path separators", () => {
    expect(matchesAnyGlob("private/secret/x.png", ["private/**"])).toBe(true);
    expect(matchesAnyGlob("private/x.png", ["private/**"])).toBe(true);
    expect(matchesAnyGlob("public/x.png", ["private/**"])).toBe(false);
  });

  it("treats ? as a single non-separator char and escapes regex meta", () => {
    expect(matchesAnyGlob("a.png", ["?.png"])).toBe(true);
    expect(matchesAnyGlob("ab.png", ["?.png"])).toBe(false);
    expect(matchesAnyGlob("a+b.png", ["a+b.png"])).toBe(true);
    expect(matchesAnyGlob("axb.png", ["a+b.png"])).toBe(false);
  });

  it("returns false when no globs are given", () => {
    expect(matchesAnyGlob("anything", [])).toBe(false);
  });

  it("honors negative globs in order", () => {
    expect(matchesAnyGlob("snippets/a.css", ["**/*", "!snippets/**"])).toBe(false);
    expect(matchesAnyGlob("hotkeys.json", ["**/*", "!snippets/**"])).toBe(true);
    expect(matchesAnyGlob("snippets/a.css", ["!snippets/**", "snippets/*.css"])).toBe(true);
  });
});
