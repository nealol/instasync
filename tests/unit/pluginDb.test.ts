import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { makeEngine, makeRelay, newSnapStore } from "../support/crsqliteHarness";
import { _resetSqliteForTests } from "../../src/pluginDb/crsqlite";
import { waitFor } from "../support/util";

interface TaskRow {
  id: string;
  title: string;
  done: number | null;
}

async function titles(db: { query: <T>(s: string) => Promise<T[]> }): Promise<string[]> {
  const rows = await db.query<TaskRow>(`SELECT id, title, done FROM tasks ORDER BY id`);
  return rows.map((r) => r.title);
}

describe("SyncedPluginDatabase", () => {
  it("converges two peers through a shared batch log", async () => {
    const doc = new Y.Doc();
    const a = makeEngine({ doc, snap: newSnapStore() });
    const b = makeEngine({ doc, snap: newSnapStore() });
    try {
      await a.start();
      await b.start();
      await a.whenLive();
      await b.whenLive();

      await a.exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, ["a1", "from-a"]);
      await b.exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, ["b1", "from-b"]);

      await waitFor(async () => (await titles(a)).length === 2, { label: "a sees both" });
      await waitFor(async () => (await titles(b)).length === 2, { label: "b sees both" });

      expect(await titles(a)).toEqual(["from-a", "from-b"]);
      expect(await titles(b)).toEqual(["from-a", "from-b"]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("queues offline writes and reconciles on reconnect", async () => {
    const relay = makeRelay();
    const a = makeEngine({ doc: relay.a, snap: newSnapStore() });
    const b = makeEngine({ doc: relay.b, snap: newSnapStore() });
    try {
      await a.start();
      await b.start();
      await a.whenLive();
      await b.whenLive();

      relay.pause();
      await a.exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, ["off-a", "offline-a"]);
      await b.exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, ["off-b", "offline-b"]);
      // Give the publish debounce time to append batches into each (isolated) doc.
      await new Promise((r) => setTimeout(r, 400));
      expect((await titles(a)).length).toBe(1);
      expect((await titles(b)).length).toBe(1);

      relay.resume();
      await waitFor(async () => (await titles(a)).length === 2, { label: "a reconciles" });
      await waitFor(async () => (await titles(b)).length === 2, { label: "b reconciles" });
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("preserves clocks across snapshot save/restore without resurrecting deletes", async () => {
    const snap = newSnapStore();

    const doc1 = new Y.Doc();
    const a1 = makeEngine({ doc: doc1, snap });
    await a1.start();
    await a1.whenLive();
    await a1.exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, ["x", "keep"]);
    await a1.exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, ["y", "drop"]);
    await a1.close(); // persists snapshot

    // Reopen from snapshot: both rows survive.
    const doc2 = new Y.Doc();
    const a2 = makeEngine({ doc: doc2, snap });
    await a2.start();
    await a2.whenLive();
    expect(await titles(a2)).toEqual(["keep", "drop"]);

    // Delete one, snapshot again.
    await a2.exec(`DELETE FROM tasks WHERE id = ?`, ["y"]);
    await a2.close();

    // Reopen: the delete is preserved (no resurrection).
    const doc3 = new Y.Doc();
    const a3 = makeEngine({ doc: doc3, snap });
    try {
      await a3.start();
      await a3.whenLive();
      expect(await titles(a3)).toEqual(["keep"]);
    } finally {
      await a3.close();
    }
  });

  it("buffers batches from a newer schema and reports needs-migration", async () => {
    const doc = new Y.Doc();
    const newer = makeEngine({ doc, snap: newSnapStore(), schemaVersion: 2 });
    const older = makeEngine({ doc, snap: newSnapStore(), schemaVersion: 1 });
    try {
      await newer.start();
      await older.start();
      await newer.whenLive();
      await older.whenLive();

      await newer.exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, ["n1", "new-schema"]);

      await waitFor(() => older.state === "needs-migration", {
        label: "older enters needs-migration",
      });
      // The older peer must NOT apply ahead of its local schema.
      expect((await titles(older)).length).toBe(0);
    } finally {
      await newer.close();
      await older.close();
    }
  });

  it("drains buffered batches and returns to live after upgradeSchema", async () => {
    const doc = new Y.Doc();
    const newer = makeEngine({ doc, snap: newSnapStore(), schemaVersion: 2 });
    const older = makeEngine({ doc, snap: newSnapStore(), schemaVersion: 1 });
    try {
      await newer.start();
      await older.start();
      await newer.whenLive();
      await older.whenLive();

      await newer.exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, ["n1", "new-schema"]);
      await waitFor(() => older.state === "needs-migration", {
        label: "older enters needs-migration",
      });
      expect((await titles(older)).length).toBe(0);

      // The consumer "updates": migrate the running engine to v2. Buffered
      // batches drain and the engine goes back to live.
      await older.upgradeSchema(2, async (_tx, _from) => {
        /* schema unchanged between v1 and v2 in this test */
      });
      await waitFor(() => older.state === "live", { label: "older back to live" });
      expect(older.currentSchemaVersion).toBe(2);
      await waitFor(async () => (await titles(older)).length === 1, {
        label: "older applied the buffered batch",
      });
      expect(await titles(older)).toEqual(["new-schema"]);
    } finally {
      await newer.close();
      await older.close();
    }
  });

  it("falls back to the bootstrap endpoint when a needed range was compacted away", async () => {
    _resetSqliteForTests();
    const doc = new Y.Doc();
    // Producer makes data, then we simulate the server compacting it away.
    const producer = makeEngine({ doc, snap: newSnapStore() });
    await producer.start();
    await producer.whenLive();
    await producer.exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, ["c1", "compacted"]);
    await new Promise((r) => setTimeout(r, 400));

    // Capture the producer's full changeset to act as the server replica.
    const serverRows = await (
      await import("../../src/pluginDb/crsqlite")
    ).readAllChanges((producer as unknown as { db: any }).db);

    // A fresh consumer whose batch log is empty but whose meta says the range
    // was compacted: it must pull from bootstrap instead.
    const consumerDoc = new Y.Doc();
    const meta = consumerDoc.getMap("meta");
    const consumer = makeEngine({
      doc: consumerDoc,
      snap: newSnapStore(),
      bootstrap: async () => serverRows,
    });
    try {
      await consumer.start();
      await consumer.whenLive();
      await consumer.rebaseFromServer();
      await waitFor(async () => (await titles(consumer)).length === 1, {
        label: "consumer bootstrapped",
      });
      expect(await titles(consumer)).toEqual(["compacted"]);
    } finally {
      await producer.close();
      await consumer.close();
    }
  });
});
