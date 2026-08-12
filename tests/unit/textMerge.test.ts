import { describe, expect, it } from "vitest";
import { mergeText } from "../../src/textMerge";

describe("mergeText", () => {
  it("merges simultaneous offline edits from two stale devices when they are disjoint", () => {
    expect(
      mergeText(
        "title\nfirst\nsecond\n",
        "local title\nfirst\nsecond\n",
        "title\nfirst\nremote second\n",
      ),
    ).toEqual({ kind: "merged", content: "local title\nfirst\nremote second\n" });
  });

  it("deduplicates the same edit made independently", () => {
    expect(mergeText("before\n", "after\n", "after\n")).toEqual({
      kind: "merged",
      content: "after\n",
    });
  });

  it("refuses to guess when edits overlap", () => {
    expect(mergeText("base\n", "local\n", "remote\n")).toEqual({ kind: "conflict" });
  });

  it("preserves exact trailing-newline state", () => {
    expect(mergeText("a\nb", "A\nb", "a\nB")).toEqual({
      kind: "merged",
      content: "A\nB",
    });
  });
});
