import { describe, expect, it } from "vitest";
import { isExcluded, kindForPath } from "../../src/kinds";

describe("kindForPath", () => {
	it("routes by extension", () => {
		expect(kindForPath("Notes/Hello.md")).toBe("note");
		expect(kindForPath("Boards/Plan.canvas")).toBe("canvas");
		expect(kindForPath("Tables/Tasks.base")).toBe("base");
		expect(kindForPath("img/photo.png")).toBe("attachment");
		expect(kindForPath("README")).toBe("attachment");
	});

	it("is case-insensitive on the extension", () => {
		expect(kindForPath("UPPER.MD")).toBe("note");
	});
});

describe("isExcluded", () => {
	it("excludes .rtmd and dot paths at any depth", () => {
		expect(isExcluded(".rtmd")).toBe(true);
		expect(isExcluded(".git/config")).toBe(true);
		expect(isExcluded("sub/.obsidian/app.json")).toBe(true);
		expect(isExcluded("sub/.hidden.md")).toBe(true);
	});

	it("keeps normal paths", () => {
		expect(isExcluded("Notes/Hello.md")).toBe(false);
		expect(isExcluded("a.b/c.md")).toBe(false);
	});
});
