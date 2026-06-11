import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../../src/Markdown";

function render(content: string): string {
	return renderToStaticMarkup(<Markdown shareId="share123" content={content} />);
}

describe("Markdown component", () => {
	it("renders highlights, tags and headings", () => {
		const html = render("# Title\n\nsome ==marked== text with #a-tag");
		expect(html).toContain("<h1>Title</h1>");
		expect(html).toContain("<mark>marked</mark>");
		expect(html).toContain('<span class="tag">#a-tag</span>');
	});

	it("renders wikilinks as unresolved spans before lookup completes", () => {
		const html = render("see [[Other Note|friendly]]");
		expect(html).toContain("wikilink-unresolved");
		expect(html).toContain("friendly");
	});

	it("renders image embeds against the share-scoped attachment route", () => {
		const html = render("![[pics/cat.png]]");
		expect(html).toContain('src="/api/view/share123/attachments/pics/cat.png"');
	});

	it("renders callouts with type, title and body", () => {
		const html = render("> [!warning]- Be careful\n> details here");
		expect(html).toContain("callout-warning");
		expect(html).toContain("Be careful");
		expect(html).toContain("details here");
		expect(html).toContain("<details");
	});

	it("renders frontmatter as a properties table", () => {
		const html = render("---\nstatus: draft\n---\nbody");
		expect(html).toContain("frontmatter-key");
		expect(html).toContain("draft");
	});

	it("renders math via KaTeX", () => {
		expect(render("inline $x^2$ math")).toContain("katex");
	});

	it("renders GFM tables and task lists", () => {
		const html = render("| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done");
		expect(html).toContain("<table>");
		expect(html).toContain('type="checkbox"');
	});
});
