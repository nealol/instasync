import type { Http } from "../http";
import { encodePath } from "../http";
import type {
  FrontmatterResponse,
  Note,
  NoteSummary,
  PatchFrontmatterBody,
  PatchNoteBody,
  PeriodicPeriod,
  PermalinkResponse,
} from "../types";

export class NotesResource {
  constructor(
    private http: Http,
    private vaultId: string,
  ) {}

  private note(path: string): string {
    return `/api/vaults/${this.vaultId}/notes/${encodePath(path)}`;
  }

  list(): Promise<NoteSummary[]> {
    return this.http.request("GET", `/api/vaults/${this.vaultId}/notes`);
  }

  read(path: string): Promise<Note> {
    return this.http.request("GET", this.note(path));
  }

  create(path: string, content = ""): Promise<Note> {
    return this.http.request("POST", `/api/vaults/${this.vaultId}/notes`, {
      body: { path, content },
    });
  }

  replace(path: string, content: string): Promise<Note> {
    return this.http.request("PUT", this.note(path), { body: { content } });
  }

  patch(path: string, edit: PatchNoteBody): Promise<Note> {
    return this.http.request("PATCH", this.note(path), {
      body: { old: edit.old, new: edit.new, replaceAll: edit.replaceAll ?? false },
    });
  }

  /**
   * Convenience read-then-replace appending `text` on a fresh line. Not
   * atomic: prefer `patch` with a unique anchor when contention is possible.
   */
  async append(path: string, text: string): Promise<Note> {
    const current = await this.read(path);
    const glue = current.content.length === 0 || current.content.endsWith("\n") ? "" : "\n";
    return this.replace(path, `${current.content}${glue}${text}`);
  }

  move(path: string, toPath: string): Promise<Note> {
    return this.http.request("POST", `/api/vaults/${this.vaultId}/note-moves/${encodePath(path)}`, {
      body: { toPath },
    });
  }

  async delete(path: string): Promise<void> {
    await this.http.request("DELETE", this.note(path));
  }

  permalink(path: string): Promise<PermalinkResponse> {
    return this.http.request(
      "POST",
      `/api/vaults/${this.vaultId}/note-permalinks/${encodePath(path)}`,
    );
  }
}

export class FrontmatterResource {
  constructor(
    private http: Http,
    private vaultId: string,
  ) {}

  parse(path: string): Promise<FrontmatterResponse> {
    return this.http.request(
      "GET",
      `/api/vaults/${this.vaultId}/note-frontmatter/${encodePath(path)}`,
    );
  }

  /** Set/unset frontmatter keys; returns the updated note. */
  patch(path: string, edit: PatchFrontmatterBody): Promise<Note> {
    return this.http.request(
      "PATCH",
      `/api/vaults/${this.vaultId}/note-frontmatter/${encodePath(path)}`,
      {
        body: { set: edit.set ?? {}, unset: edit.unset ?? [] },
      },
    );
  }
}

export class PeriodicNotesResource {
  constructor(
    private http: Http,
    private vaultId: string,
  ) {}

  /** Get or create the periodic note for `period` (today unless `date` given). */
  getOrCreate(
    period: PeriodicPeriod,
    opts: { date?: string; content?: string } = {},
  ): Promise<Note> {
    return this.http.request("POST", `/api/vaults/${this.vaultId}/periodic/${period}`, {
      body: { date: opts.date, content: opts.content ?? "" },
    });
  }

  append(period: PeriodicPeriod, text: string, opts: { date?: string } = {}): Promise<Note> {
    return this.http.request("POST", `/api/vaults/${this.vaultId}/periodic/${period}/append`, {
      body: { date: opts.date, text },
    });
  }
}
