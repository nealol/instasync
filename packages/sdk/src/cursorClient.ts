import { Http, staticToken, type TokenProvider } from "./http";
import { VaultHandle } from "./client";
import { NoteStream, streamText, streamUrlFor, type WebSocketConstructor } from "./stream";
import type { StreamAnchor, StreamResult } from "./types";

export interface CursorClientOptions {
	/** Server origin, e.g. `https://realtime.example.com`. */
	baseUrl: string;
	/** The vault this cursor is bound to. */
	vaultId: string;
	/** A cursor secret token or OAuth access token. */
	token?: string;
	/** Alternative to `token`: e.g. an auto-refreshing OAuth provider. */
	tokenProvider?: TokenProvider;
	/** Override for tests; defaults to `globalThis.fetch`. */
	fetch?: typeof fetch;
	/** Override the WebSocket implementation for streaming. */
	webSocket?: WebSocketConstructor;
}

/**
 * A remote-cursor-authenticated client, pinned to one vault. Every mutation is
 * attributed to the cursor robot in Git and recorded in its audit log.
 *
 * Authenticate with a cursor secret token (from cursor creation / regenerate),
 * a plugin cursor grant, or an OAuth access token (see `loginCursorViaOAuth`
 * in `@realtime-md/sdk/node`).
 */
export class CursorClient {
	readonly http: Http;
	readonly vaultId: string;
	/** Vault API surfaces (notes, search, attachments, ...) as the cursor. */
	readonly vault: VaultHandle;
	private baseUrl: string;
	private tokenSource: TokenProvider;
	private webSocket?: WebSocketConstructor;

	constructor(opts: CursorClientOptions) {
		const auth = opts.tokenProvider ?? (opts.token !== undefined ? staticToken(opts.token) : undefined);
		if (!auth) throw new Error("CursorClient requires `token` or `tokenProvider`");
		this.tokenSource = auth;
		this.baseUrl = opts.baseUrl;
		this.vaultId = opts.vaultId;
		this.http = new Http({ baseUrl: opts.baseUrl, auth, fetch: opts.fetch });
		this.vault = new VaultHandle(this.http, opts.vaultId);
		this.webSocket = opts.webSocket;
	}

	/** Shorthand for the cursor's most common surface. */
	get notes() {
		return this.vault.notes;
	}

	/** Open a live token-streaming session into a note. */
	async stream(path: string, anchor?: StreamAnchor): Promise<NoteStream> {
		return NoteStream.open({
			url: streamUrlFor(this.baseUrl, this.vaultId),
			token: await this.tokenSource.getToken(),
			path,
			anchor,
			webSocket: this.webSocket,
		});
	}

	/** One-shot: stream all of `text` into `path` and commit. */
	async streamText(
		path: string,
		text: AsyncIterable<string> | Iterable<string>,
		anchor?: StreamAnchor,
	): Promise<StreamResult> {
		return streamText({
			url: streamUrlFor(this.baseUrl, this.vaultId),
			token: await this.tokenSource.getToken(),
			path,
			anchor,
			text,
			webSocket: this.webSocket,
		});
	}
}
