import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";

export type MaterializedKind = "text" | "canvas" | "base" | "binary" | "config";

/**
 * Device-local record of paths that were successfully present on disk.
 *
 * The shared index cannot distinguish a fresh device (missing means pull) from
 * a device that deleted a file while Obsidian was stopped (missing means
 * delete). This small IndexedDB-backed map provides that distinction without
 * publishing device-local filesystem state to collaborators.
 */
export class LocalSyncState {
  private readonly doc = new Y.Doc();
  private readonly paths = this.doc.getMap<MaterializedKind>("materialized");
  private readonly persistence: IndexeddbPersistence;
  readonly whenSynced: Promise<void>;

  constructor(scope: string) {
    this.persistence = new IndexeddbPersistence(`realtime:local-state:${scope}`, this.doc);
    this.whenSynced = this.persistence.whenSynced.then(
      () => undefined,
      (error) => {
        console.error("[Realtime] local sync state failed to load", error);
      },
    );
  }

  has(path: string): boolean {
    return this.paths.has(path);
  }

  mark(path: string, kind: MaterializedKind): void {
    if (this.paths.get(path) !== kind) this.paths.set(path, kind);
  }

  remove(path: string): void {
    this.paths.delete(path);
  }

  destroy(): void {
    this.persistence.destroy();
    this.doc.destroy();
  }
}
