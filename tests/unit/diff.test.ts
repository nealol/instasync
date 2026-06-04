import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { applyTextToYText } from "../../src/diff";

function apply(initial: string, target: string): string {
	const doc = new Y.Doc();
	const text = doc.getText("contents");
	if (initial) text.insert(0, initial);
	doc.transact(() => applyTextToYText(text, target, "test"));
	return text.toString();
}

describe("applyTextToYText", () => {
	it("inserts into empty text", () => {
		expect(apply("", "hello world")).toBe("hello world");
	});

	it("is a no-op when unchanged", () => {
		const doc = new Y.Doc();
		const text = doc.getText("contents");
		text.insert(0, "same");
		let changed = false;
		text.observe(() => (changed = true));
		doc.transact(() => applyTextToYText(text, "same", "test"));
		expect(text.toString()).toBe("same");
		expect(changed).toBe(false);
	});

	it("appends at the end (common prefix)", () => {
		expect(apply("hello", "hello world")).toBe("hello world");
	});

	it("prepends at the start (common suffix)", () => {
		expect(apply("world", "hello world")).toBe("hello world");
	});

	it("replaces only the differing middle", () => {
		expect(apply("the quick brown fox", "the slow brown fox")).toBe(
			"the slow brown fox",
		);
	});

	it("handles a pure deletion", () => {
		expect(apply("hello world", "hello")).toBe("hello");
	});

	it("preserves a concurrent edit outside the changed region", () => {
		// Two docs sharing a baseline; one rewrites the middle via the diff, the
		// other appends — the CRDT keeps both.
		const a = new Y.Doc();
		const ta = a.getText("contents");
		ta.insert(0, "the quick brown fox");
		const b = new Y.Doc();
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		const tb = b.getText("contents");

		a.transact(() => applyTextToYText(ta, "the slow brown fox", "test"));
		tb.insert(tb.length, "!"); // concurrent append on b

		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		expect(ta.toString()).toBe(tb.toString());
		expect(ta.toString()).toBe("the slow brown fox!");
	});
});
