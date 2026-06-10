// Regenerates server/tests/fixtures/client-published-doc.bin — a plugin-db
// Y.Doc update produced by the REAL TypeScript client engine, used by the Rust
// cross-stack wire-format regression test
// (`plugin_db_decodes_and_replicates_a_real_client_published_doc`).
//
// Run from the repo root after any wire-format change:
//
//   npx tsx tests/support/genPluginDbDocFixture.mts
//
// Why this exists: JS clients encode numbers into Yjs as float64, base64 their
// blobs, etc. — details that Rust-fabricated test docs do not reproduce. This
// fixture pins the real client encoding so server-side decode drift fails a
// test instead of silently disabling replication.
import "fake-indexeddb/auto";
import * as fs from "fs";
import * as path from "path";
import * as Y from "yjs";
import { fileURLToPath } from "url";
import { makeEngine, newSnapStore } from "./crsqliteHarness";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../../server/tests/fixtures/client-published-doc.bin");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const doc = new Y.Doc();
const engine = makeEngine({ doc, snap: newSnapStore() });
await engine.start();
await engine.whenLive();
await engine.exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, ["a1", "from-A"]);
await engine.exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, ["b1", "from-B"]);
await sleep(600); // let the publish debounce append the batch

const batches = doc.getArray("batches").toArray();
if (batches.length === 0) throw new Error("no batches were published; fixture would be useless");

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(Y.encodeStateAsUpdate(doc)));
console.log(`wrote ${out} (${fs.statSync(out).size} bytes, ${batches.length} batch(es))`);
await engine.close();
process.exit(0);
