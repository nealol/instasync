import { describe, it, expect } from "vitest";
import { parseGlobs, matchesAnyGlob, matchesConfigGlobs } from "../../src/glob";

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
});

describe("matchesConfigGlobs", () => {
	it("matches globs relative to the config dir", () => {
		expect(matchesConfigGlobs(".obsidian/snippets/a.css", ".obsidian", ["snippets/*.css"])).toBe(true);
		expect(matchesConfigGlobs(".obsidian/hotkeys.json", ".obsidian", ["hotkeys.json"])).toBe(true);
		expect(matchesConfigGlobs(".obsidian/snippets/a.css", ".obsidian", ["*.css"])).toBe(false);
	});

	it("matches ** across nested config segments", () => {
		expect(matchesConfigGlobs(".obsidian/snippets/sub/a.css", ".obsidian", ["snippets/**"])).toBe(true);
	});

	it("honors a custom config dir", () => {
		expect(matchesConfigGlobs(".obsidian-custom/snippets/a.css", ".obsidian-custom", ["snippets/*.css"])).toBe(true);
		// A path under the default dir must not match when a custom dir is configured.
		expect(matchesConfigGlobs(".obsidian/snippets/a.css", ".obsidian-custom", ["snippets/*.css"])).toBe(false);
	});

	it("returns false for paths outside the config dir", () => {
		expect(matchesConfigGlobs("notes/a.md", ".obsidian", ["**"])).toBe(false);
		expect(matchesConfigGlobs(".obsidianX/a.css", ".obsidian", ["*.css"])).toBe(false);
	});

	it("returns false when no globs are given", () => {
		expect(matchesConfigGlobs(".obsidian/hotkeys.json", ".obsidian", [])).toBe(false);
	});
});
