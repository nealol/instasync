/**
 * Obsidian-flavored markdown support on top of remark: highlights (`==x==`),
 * tags (`#tag`), wikilinks (`[[Note|alias]]`), embeds (`![[file]]`), and
 * callouts (`> [!note]`). Inline syntaxes are implemented by splitting mdast
 * text nodes; the produced nodes carry `data.hName`/`data.hProperties`, which
 * remark-rehype turns into custom elements that `Markdown.tsx` maps to React
 * components. Comments (`%%..%%`) and frontmatter are stripped before parsing.
 */

import type { Blockquote, Paragraph, Parent, Root, Text } from "mdast";
import { visit } from "unist-util-visit";
import { parse as parseYaml } from "yaml";

export interface Preprocessed {
	body: string;
	frontmatter: Record<string, unknown> | null;
}

/** Strip `%%..%%` comments (outside code) and extract YAML frontmatter. */
export function preprocess(raw: string): Preprocessed {
	let body = raw;
	let frontmatter: Record<string, unknown> | null = null;

	const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (fm) {
		try {
			const parsed = parseYaml(fm[1]);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				frontmatter = parsed as Record<string, unknown>;
			}
		} catch {
			// Malformed frontmatter is still hidden from the rendered body.
		}
		body = body.slice(fm[0].length);
	}

	// Remove %%comments%% everywhere except inside code fences / inline code.
	body = body
		.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/)
		.map((segment, i) => (i % 2 === 1 ? segment : segment.replace(/%%[\s\S]*?%%/g, "")))
		.join("");

	return { body, frontmatter };
}

type Built = { node: InlineNode | null };
type InlineNode = {
	type: string;
	data: { hName: string; hProperties?: Record<string, unknown> };
	children?: Array<Text>;
};

function text(value: string): Text {
	return { type: "text", value };
}

/** Split every text node on `regex`, replacing matches via `build`. */
function splitTextNodes(
	tree: Root,
	regex: RegExp,
	build: (match: RegExpExecArray) => Built["node"],
): void {
	visit(tree, "text", (node: Text, index, parent) => {
		if (!parent || index === undefined) return;
		const value = node.value;
		const out: Array<Text | InlineNode> = [];
		let last = 0;
		regex.lastIndex = 0;
		for (let m = regex.exec(value); m; m = regex.exec(value)) {
			const built = build(m);
			if (!built) continue;
			if (m.index > last) out.push(text(value.slice(last, m.index)));
			out.push(built);
			last = m.index + m[0].length;
		}
		if (out.length === 0) return undefined;
		if (last < value.length) out.push(text(value.slice(last)));
		(parent as Parent).children.splice(index, 1, ...(out as Parent["children"]));
		return index + out.length;
	});
}

/** `==highlighted==` → `<mark>` */
export function remarkHighlight() {
	return (tree: Root) => {
		splitTextNodes(tree, /==([^=\n][^=\n]*?)==/g, (m) => ({
			type: "obsidianHighlight",
			data: { hName: "mark" },
			children: [text(m[1])],
		}));
	};
}

/** `#tag` → `<span class="tag">` (after whitespace or start of text only). */
export function remarkTags() {
	return (tree: Root) => {
		splitTextNodes(tree, /(?<=^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu, (m) => ({
			type: "obsidianTag",
			data: { hName: "span", hProperties: { className: "tag" } },
			children: [text(`#${m[1]}`)],
		}));
	};
}

/**
 * `[[Target|alias]]` and `![[Target]]` → custom `wikilink` / `embed` elements
 * (resolved and rendered client-side; targets may carry `#heading` anchors,
 * which we keep for display but drop for resolution).
 */
export function remarkWikilinks() {
	return (tree: Root) => {
		splitTextNodes(tree, /(!?)\[\[([^[\]|]+?)(?:\|([^[\]]+?))?\]\]/g, (m) => {
			const isEmbed = m[1] === "!";
			const rawTarget = m[2].trim();
			const target = rawTarget.split("#")[0].trim();
			const alias = (m[3] ?? rawTarget).trim();
			if (!target && !isEmbed) return null;
			return {
				type: isEmbed ? "obsidianEmbed" : "obsidianWikilink",
				data: {
					hName: isEmbed ? "obsidian-embed" : "obsidian-wikilink",
					hProperties: { target, alias },
				},
				children: isEmbed ? [] : [text(alias)],
			};
		});
	};
}

export interface CalloutInfo {
	type: string;
	title: string;
	collapsible: boolean;
	folded: boolean;
}

const CALLOUT_RE = /^\[!([A-Za-z][\w-]*)\]([+-])?[ \t]?([^\n]*)\n?/;

/** `> [!note]- Title` blockquotes → custom `obsidian-callout` elements. */
export function remarkCallouts() {
	return (tree: Root) => {
		visit(tree, "blockquote", (node: Blockquote) => {
			const first = node.children[0];
			if (!first || first.type !== "paragraph") return;
			const firstText = (first as Paragraph).children[0];
			if (!firstText || firstText.type !== "text") return;
			const m = (firstText as Text).value.match(CALLOUT_RE);
			if (!m) return;

			const [, type, fold, title] = m;
			(firstText as Text).value = (firstText as Text).value.slice(m[0].length);
			// Drop the directive paragraph entirely if nothing remains of it.
			if ((firstText as Text).value === "" && (first as Paragraph).children.length === 1) {
				node.children.shift();
			}
			node.data = {
				...node.data,
				hName: "obsidian-callout",
				hProperties: {
					calloutType: type.toLowerCase(),
					calloutTitle: title.trim(),
					collapsible: fold !== undefined,
					folded: fold === "-",
				},
			};
		});
	};
}
