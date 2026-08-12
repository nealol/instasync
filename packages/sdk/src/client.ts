import { Http, staticToken, type TokenProvider } from "./http";
import type { DocTokenResponse, MeResponse, PluginDbInfo, ServerInfoResponse } from "./types";
import { NotesResource, FrontmatterResource, PeriodicNotesResource } from "./resources/notes";
import {
  VaultsResource,
  InvitesResource,
  MembersResource,
  CursorsResource,
} from "./resources/vaults";
import { AttachmentsResource, BlobsResource } from "./resources/attachments";
import { CanvasesResource, BasesResource } from "./resources/structured";
import {
  SearchResource,
  StorageResource,
  BackupResource,
  PluginDbResource,
} from "./resources/misc";
import { HistoryResource } from "./resources/history";
import { SharesResource } from "./resources/shares";

export interface RealtimeClientOptions {
  /** Server origin, e.g. `https://realtime.example.com`. */
  baseUrl: string;
  /** A session bearer token (from the Obsidian plugin's login or paste flow). */
  token?: string;
  /** Alternative to `token`: a provider that can refresh/re-mint. */
  tokenProvider?: TokenProvider;
  /** Override for tests; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/**
 * All per-vault API surfaces, bound to one vault id. Obtain via
 * {@link RealtimeClient.vault} or {@link CursorClient.vault}.
 */
export class VaultHandle {
  readonly notes: NotesResource;
  readonly frontmatter: FrontmatterResource;
  readonly periodic: PeriodicNotesResource;
  readonly attachments: AttachmentsResource;
  readonly blobs: BlobsResource;
  readonly canvases: CanvasesResource;
  readonly bases: BasesResource;
  readonly search: SearchResource;
  readonly storage: StorageResource;
  readonly backup: BackupResource;
  readonly members: MembersResource;
  readonly cursors: CursorsResource;
  readonly history: HistoryResource;
  readonly shares: SharesResource;

  constructor(
    private http: Http,
    readonly vaultId: string,
  ) {
    this.notes = new NotesResource(http, vaultId);
    this.frontmatter = new FrontmatterResource(http, vaultId);
    this.periodic = new PeriodicNotesResource(http, vaultId);
    this.attachments = new AttachmentsResource(http, vaultId);
    this.blobs = new BlobsResource(http, vaultId);
    this.canvases = new CanvasesResource(http, vaultId);
    this.bases = new BasesResource(http, vaultId);
    this.search = new SearchResource(http, vaultId);
    this.storage = new StorageResource(http, vaultId);
    this.backup = new BackupResource(http, vaultId);
    this.members = new MembersResource(http, vaultId);
    this.cursors = new CursorsResource(http, vaultId);
    this.history = new HistoryResource(http, vaultId);
    this.shares = new SharesResource(http, vaultId);
  }

  /** Replication endpoints for one synced plugin database. */
  pluginDb(pluginId: string, name: string): PluginDbResource {
    return new PluginDbResource(this.http, this.vaultId, pluginId, name);
  }
  /** List synced plugin databases the server holds a replica for. */
  async listPluginDbs(): Promise<PluginDbInfo[]> {
    const res = await this.http.request<{ databases: PluginDbInfo[] }>(
      "GET",
      `/api/vaults/${this.vaultId}/plugin-dbs`,
    );
    return res.databases;
  }

  /** Register a file guid→path mapping in the vault file registry. */
  async registerFile(guid: string, path: string): Promise<void> {
    await this.http.request("POST", `/api/vaults/${this.vaultId}/files`, { body: { guid, path } });
  }
}

/**
 * A user-authenticated Realtime API client (session bearer token).
 *
 * ```ts
 * const client = new RealtimeClient({ baseUrl, token });
 * const vault = client.vault((await client.vaults.create("Notes")).id);
 * await vault.notes.create("Hello.md", "# Hello");
 * ```
 */
export class RealtimeClient {
  readonly http: Http;
  readonly vaults: VaultsResource;
  readonly invites: InvitesResource;

  constructor(opts: RealtimeClientOptions) {
    const auth =
      opts.tokenProvider ?? (opts.token !== undefined ? staticToken(opts.token) : undefined);
    if (!auth) throw new Error("RealtimeClient requires `token` or `tokenProvider`");
    this.http = new Http({ baseUrl: opts.baseUrl, auth, fetch: opts.fetch });
    this.vaults = new VaultsResource(this.http);
    this.invites = new InvitesResource(this.http);
  }

  me(): Promise<MeResponse> {
    return this.http.request("GET", "/api/me");
  }

  updateMe(body: {
    gitEmail?: string | null;
    avatarUrlOverride?: string | null;
  }): Promise<MeResponse> {
    return this.http.request("PATCH", "/api/me", { body });
  }

  serverInfo(): Promise<ServerInfoResponse> {
    return this.http.request("GET", "/api/server-info");
  }

  /** Invalidate the session token server-side. */
  async logout(): Promise<void> {
    await this.http.request("POST", "/api/logout");
  }

  vault(vaultId: string): VaultHandle {
    return new VaultHandle(this.http, vaultId);
  }

  /** Mint a document token for direct Yjs access. */
  docToken(vaultId: string, docId: string, path?: string): Promise<DocTokenResponse> {
    return this.http.request("POST", "/api/doc-token", {
      body: { vaultId, docId, ...(path ? { path } : {}) },
    });
  }
}
