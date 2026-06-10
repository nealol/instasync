# Conflict resolution

[← Back to index](./README.md)

cr-sqlite resolves all merges automatically. **Nothing ever errors and every
replica converges to the same state.** Your job is to design a schema and write
queries that produce a *meaningful* converged state — the engine guarantees
agreement, not that the agreed value is the one you wanted.

## Merge semantics

- **Column-level last-writer-wins (LWW).** Each column carries a lamport version
  (`col_version`); the higher version wins, ties broken by the value. Two devices
  editing *different* columns of the same row both keep their edits. Two devices
  editing the *same* column — the last writer wins.
- **Causal length for whole-row create/delete.** Insert/delete races on the same
  primary key are resolved by a causal-length counter (`cl`), so deletes are
  resurrection-safe and converge deterministically.

There is no error path, no "conflict" object, and no merge callback at the row
level — because none is needed.

## The counter anti-pattern

Because writes are LWW per column, a blind read-modify-write **loses
increments**:

```ts
// ANTI-PATTERN: two offline devices both read 5, both write 6 → final is 6, not 7.
const [{ n }] = await db.query<{ n: number }>(`SELECT votes n FROM posts WHERE id = ?`, [id]);
await db.exec(`UPDATE posts SET votes = ? WHERE id = ?`, [n + 1, id]);
```

`UPDATE posts SET votes = votes + 1` has the same problem: it resolves to a single
LWW column value, not a sum.

### CRDT-friendly alternatives

Model the counter as **rows you insert**, then aggregate at read time:

```ts
migrate: async (tx) => {
  await tx.exec(`CREATE TABLE post_votes (id TEXT PRIMARY KEY NOT NULL, post_id, voter, delta)`);
  await tx.exec(`SELECT crsql_as_crr('post_votes')`);
}

// Each vote is an independent insert — they all merge, none clobber the others.
await db.exec(
  `INSERT INTO post_votes (id, post_id, voter, delta) VALUES (?, ?, ?, ?)`,
  [crypto.randomUUID(), postId, voterId, +1],
);

// Read the total by aggregation.
const [{ total }] = await db.query<{ total: number }>(
  `SELECT coalesce(sum(delta), 0) total FROM post_votes WHERE post_id = ?`, [postId],
);
```

This "operation log + aggregate" pattern (a PN-Counter / G-Set) is the general
way to get commutative behavior on top of LWW storage. Use it for counters,
sets, tallies, and append-only collections.

## Application-invariant conflicts and `onMergeReview`

Some invariants can't be expressed as a SQL `UNIQUE` (which CRRs forbid) — for
example, "at most one task per (list, position)" or "logical id is unique". After
a remote merge, two replicas might transiently both hold a row that violates your
invariant. Use the optional `onMergeReview` hook to run a repair query whenever
remote changes land:

```ts
const db = await realtime.sql.open({
  pluginId: this.manifest.id,
  name: "tasks",
  schemaVersion: 1,
  migrate,
  onMergeReview: async (tables) => {
    if (!tables.includes("tasks")) return;
    // Deterministic de-dupe by a logical key: keep the lexicographically
    // smallest row id, delete the rest. Runs the same on every device, so all
    // replicas converge on the same survivor.
    await db.exec(`
      DELETE FROM tasks
      WHERE id NOT IN (
        SELECT min(id) FROM tasks GROUP BY logical_key
      )
    `);
  },
});
```

Keep repair queries **deterministic** (e.g. `min(id)`, not "the local one") so
every device makes the same decision and the repair itself converges.

> `onRemoteChange` and `onMergeReview` both fire after remote applies. Use
> `onRemoteChange` to refresh your UI; use `onMergeReview` to mutate data.
