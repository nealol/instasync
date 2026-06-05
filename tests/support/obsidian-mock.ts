// Minimal stand-in for the `obsidian` module so that src/Document.ts,
// src/VaultSync.ts and src/ysweet.ts can be imported and run under Node/vitest.
// Only the symbols those files actually import are provided.

export class TAbstractFile {
	path: string;
	name: string;
	constructor(path: string) {
		this.path = path;
		this.name = path.slice(path.lastIndexOf("/") + 1);
	}
}

export class TFile extends TAbstractFile {
	extension: string;
	basename: string;
	constructor(path: string) {
		super(path);
		const dot = this.name.lastIndexOf(".");
		this.extension = dot >= 0 ? this.name.slice(dot + 1) : "";
		this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name;
	}
}

/** Captures every Notice message so tests can assert on user-facing surfacing. */
export const notices: string[] = [];

export class Notice {
	constructor(message: string, _timeout?: number) {
		notices.push(message);
	}
}

/** Mirrors Obsidian's path normalisation closely enough for our use. */
export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/(^\/|\/$)/g, "")
		.trim();
}

/** Obsidian's CORS-bypassing fetch — backed here by Node's global fetch. */
export async function requestUrl(opts: {
	url: string;
	method?: string;
	contentType?: string;
	headers?: Record<string, string>;
	body?: string;
	throw?: boolean;
}): Promise<{ status: number; text: string; json: unknown }> {
	const headers: Record<string, string> = { ...(opts.headers ?? {}) };
	if (opts.contentType) headers["Content-Type"] = opts.contentType;
	const res = await fetch(opts.url, {
		method: opts.method ?? "GET",
		headers,
		body: opts.body,
	});
	const text = await res.text();
	let json: unknown = undefined;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		/* not json */
	}
	return { status: res.status, text, json };
}
