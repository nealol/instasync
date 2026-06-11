import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import {
	preprocess,
	remarkCallouts,
	remarkHighlight,
	remarkTags,
	remarkWikilinks,
} from "../../src/remark/obsidian";

function render(markdown: string): string {
	return unified()
		.use(remarkParse)
		.use(remarkCallouts)
		.use(remarkWikilinks)
		.use(remarkHighlight)
		.use(remarkTags)
		.use(remarkRehype)
		.use(rehypeStringify)
		.processSync(markdown)
		.toString();
}

describe("preprocess", () => {
	it("extracts frontmatter and hides it from the body", () => {
		const { body, frontmatter } = preprocess("---\ntitle: Hi\ntags: [a, b]\n---\n# Heading\n");
		expect(frontmatter).toEqual({ title: "Hi", tags: ["a", "b"] });
		expect(body).toBe("# Heading\n");
	});

	it("strips %% comments %% outside code", () => {
		const { body } = preprocess("before %%hidden%% after");
		expect(body).toBe("before  after");
	});

	it("strips multi-line comments", () => {
		const { body } = preprocess("a\n%%\nsecret\n%%\nb");
		expect(body).toBe("a\n\nb");
	});

	it("keeps %% inside code fences and inline code", () => {
		const { body } = preprocess("```\n%%not a comment%%\n```\nand `%%inline%%`");
		expect(body).toContain("%%not a comment%%");
		expect(body).toContain("`%%inline%%`");
	});

	it("tolerates malformed frontmatter", () => {
		const { body, frontmatter } = preprocess("---\n: nope: [\n---\nbody");
		expect(frontmatter).toBeNull();
		expect(body).toBe("body");
	});
});

describe("remarkHighlight", () => {
	it("renders ==text== as <mark>", () => {
		expect(render("a ==b== c")).toContain("<mark>b</mark>");
	});

	it("ignores stray equals", () => {
		expect(render("a == b")).not.toContain("<mark>");
	});
});

describe("remarkTags", () => {
	it("renders #tag as a styled span", () => {
		expect(render("hello #world")).toContain('<span class="tag">#world</span>');
	});

	it("supports nested tags and ignores mid-word hashes", () => {
		const html = render("see #a/b not mid#word");
		expect(html).toContain('<span class="tag">#a/b</span>');
		expect(html).not.toContain('<span class="tag">#word</span>');
	});

	it("does not treat headings as tags", () => {
		expect(render("# Heading")).toContain("<h1>Heading</h1>");
	});

	it("does not match pure numbers (issue refs)", () => {
		expect(render("see #123")).not.toContain('class="tag"');
	});
});

describe("remarkWikilinks", () => {
	it("renders [[Target]] as a wikilink element", () => {
		const html = render("see [[My Note]]");
		expect(html).toContain('target="My Note"');
		expect(html).toContain(">My Note</obsidian-wikilink>");
	});

	it("supports aliases and heading anchors", () => {
		const html = render("see [[Note#Section|alias]]");
		expect(html).toContain('target="Note"');
		expect(html).toContain(">alias</obsidian-wikilink>");
	});

	it("renders ![[file.png]] as an embed element", () => {
		const html = render("![[img.png]]");
		expect(html).toContain("<obsidian-embed");
		expect(html).toContain('target="img.png"');
	});
});

describe("remarkCallouts", () => {
	it("transforms [!note] blockquotes into callout elements", () => {
		const html = render("> [!note] Title\n> body text");
		expect(html).toContain("<obsidian-callout");
		expect(html).toContain('calloutType="note"');
		expect(html).toContain('calloutTitle="Title"');
		expect(html).toContain("body text");
	});

	it("marks foldable callouts", () => {
		const html = render("> [!tip]- Folded\n> hidden");
		expect(html).toContain("collapsible");
		expect(html).toContain("folded");
	});

	it("leaves plain blockquotes alone", () => {
		const html = render("> just a quote");
		expect(html).toContain("<blockquote>");
		expect(html).not.toContain("obsidian-callout");
	});
});
