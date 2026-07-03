import { browser, expect } from "@wdio/globals";
import { startWdioSession } from "wdio-obsidian-service";
import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { fileURLToPath } from "url";
import {
  readNote,
  writeNote,
  deleteNote,
  openNoteInEditor,
  typeInEditor,
  editorText,
  toggleSourceMode,
  closeAllEditors,
  listMarkdown,
  setPluginEnabled,
  installNetworkShim,
  setNetworkOffline,
  liveSocketUrls,
  statusText,
  signInDevice,
  createVaultFromLocal,
  generateInvite,
  redeemAndAdopt,
  redeemInviteOnly,
  reloadSync,
  activeVaultId,
  listedVaultIds,
  setSyncPaused,
  docTokenStatus,
  enableCorePlugin,
  openFileInLeaf,
  bindOpenStructured,
  detachLeaves,
  canvasViewData,
  editCanvasView,
  canvasPresenceMarkers,
  dispatchCanvasPointerMove,
  baseViewData,
  editBaseView,
  listTrash,
  restoreTrashEntry,
  permanentlyDeleteTrashEntry,
  sqlOpen,
  sqlInsert,
  sqlTitles,
  sqlDelete,
  sqlRestoreFromTrash,
  sqlHasTrashEntry,
  sqlTrashEntryInfo,
  sqlState,
  sqlRebaseFromServer,
  SQL_E2E_IDS,
} from "./helpers.js";
import {
  apiCreateVault,
  apiPromoteMember,
  apiRedeemInvite,
  apiRemoveMember,
  mockLogin,
} from "../../support/authServer.js";

/** Reserve then release a port so nothing listens on it — a dead endpoint. */
function reserveDeadPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const vaultB = path.resolve(here, "../vaults/vaultB");
const cacheDir = path.resolve(repoRoot, ".obsidian-cache");

const SECONDS = 1000;
const AUTH_PORT = Number(process.env.AUTH_PORT ?? 8081);
const authUrl = `http://127.0.0.1:${AUTH_PORT}`;

/** A JSON Canvas text node with the required geometry fields. */
const canvasNode = (id: string, text: string, x = 0) => ({
  id,
  type: "text",
  text,
  x,
  y: 0,
  width: 200,
  height: 60,
});
/** A JSON Canvas edge between two nodes. */
const canvasEdge = (id: string, fromNode: string, toNode: string) => ({
  id,
  fromNode,
  toNode,
});
/** Serialize a JSON Canvas document from nodes and edges. */
const canvasJson = (
  nodes: ReturnType<typeof canvasNode>[],
  edges: ReturnType<typeof canvasEdge>[] = [],
) => JSON.stringify({ nodes, edges }, null, 2);
/** A minimal valid `.base` YAML with a single named table view. */
const baseYaml = (name: string) => `views:\n  - type: table\n    name: ${name}\n`;

// Device A is the wdio session (vault A). Device B is a second, fully isolated
// Obsidian instance started programmatically (vault B). Both install this plugin;
// the conf boots y-sweet (--auth) + the auth server (mock OIDC) on the plugin's
// default ports. Device A signs in and creates a vault from its local files;
// device B signs in as a different user, redeems an invite, and adopts it.
let A: WebdriverIO.Browser;
let B: WebdriverIO.Browser;
let vaultId: string;
let adminToken: string;
let bobToken: string;

describe("Realtime — two isolated Obsidian devices", function () {
  before(async function () {
    A = browser;
    B = await startWdioSession({
      capabilities: {
        browserName: "obsidian",
        browserVersion: "latest",
        "wdio:obsidianOptions": {
          installerVersion: "earliest",
          plugins: [repoRoot],
          vault: vaultB,
          copy: true,
        },
      },
      cacheDir,
    } as any);

    // Device A: sign in, seed a file, create a vault from the local files.
    adminToken = await signInDevice(A, authUrl, "alice");
    await writeNote(A, "Seed.md", "seeded on A");
    vaultId = await createVaultFromLocal(A, "shared");

    // Device B: sign in as a different user, then redeem an invite and adopt.
    // LocalOnlyB.md must be erased by the adopt; Seed.md must be pulled in.
    bobToken = await signInDevice(B, authUrl, "bob");
    await writeNote(B, "LocalOnlyB.md", "should be erased by adopt");
    const code = await generateInvite(authUrl, adminToken, vaultId);
    await redeemAndAdopt(B, code);

    // Wait until both devices are connected ("live") before exercising sync.
    for (const [label, dev] of [
      ["A", A],
      ["B", B],
    ] as const) {
      let last = "";
      await dev.waitUntil(
        async () => {
          last = await statusText(dev);
          return /live/i.test(last);
        },
        {
          timeout: 90 * SECONDS,
          timeoutMsg: `${label} never reached 'live' (last status: ${last})`,
        },
      );
    }

    // Install the WebSocket network-cut shim on device A, then reload its plugin
    // so the providers capture the shimmed `window.WebSocket`.
    const deadPort = await reserveDeadPort();
    await installNetworkShim(A, deadPort);
    await setPluginEnabled(A, false);
    await setPluginEnabled(A, true);
    await A.waitUntil(async () => /live/i.test(await statusText(A)), {
      timeout: 90 * SECONDS,
      timeoutMsg: "A did not reconnect after installing the network shim",
    });
  });

  after(async function () {
    await B?.deleteSession();
  });

  describe("onboarding & access control", function () {
    it("adopt pulled the remote vault and erased local-only files on B", async function () {
      await B.waitUntil(async () => (await readNote(B, "Seed.md")) === "seeded on A", {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never pulled the adopted vault's Seed.md",
      });
      expect(await readNote(B, "LocalOnlyB.md")).toBe(null);
    });

    it("refuses a doc token to a non-member of the vault", async function () {
      const carol = await mockLogin(authUrl, "carol");
      const res = await fetch(`${authUrl}/api/doc-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${carol}` },
        body: JSON.stringify({ vaultId, docId: vaultId }),
      });
      expect(res.status).toBe(403);
    });

    it("redeems an invite without adopting and keeps the current active vault", async function () {
      const other = await apiCreateVault(authUrl, adminToken, "not-active");
      const code = await generateInvite(authUrl, adminToken, other.id);
      const redeemed = await redeemInviteOnly(B, code);
      expect(redeemed.vaultId).toBe(other.id);
      expect(redeemed.activeVaultId).toBe(vaultId);
      expect(await activeVaultId(B)).toBe(vaultId);
      expect(await listedVaultIds(B)).toContain(other.id);
    });
  });

  describe("live sync", function () {
    it("propagates a new note A -> B", async function () {
      await writeNote(A, "Shared.md", "hello from A");
      await B.waitUntil(async () => (await readNote(B, "Shared.md")) === "hello from A", {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never received Shared.md",
      });
    });

    it("propagates an edit B -> A", async function () {
      await writeNote(B, "Shared.md", "hello from A and B");
      await A.waitUntil(async () => (await readNote(A, "Shared.md")) === "hello from A and B", {
        timeout: 60 * SECONDS,
        timeoutMsg: "A never received B's edit",
      });
    });

    it("propagates a deletion A -> B", async function () {
      await deleteNote(A, "Shared.md");
      await B.waitUntil(async () => (await readNote(B, "Shared.md")) === null, {
        timeout: 60 * SECONDS,
        timeoutMsg: "B still has the deleted note",
      });
    });

    it("pause syncing stops propagation until syncing resumes", async function () {
      await setSyncPaused(A, true);
      await writeNote(B, "Paused.md", "written while A is paused");
      await A.pause(2 * SECONDS);
      expect(await readNote(A, "Paused.md")).toBe(null);

      await setSyncPaused(A, false);
      await A.waitUntil(
        async () => (await readNote(A, "Paused.md")) === "written while A is paused",
        { timeout: 60 * SECONDS, timeoutMsg: "A did not catch up after unpausing" },
      );
    });
  });

  describe("single-socket multiplexing", function () {
    // The point of Option A: no matter how many documents are open, the client
    // holds exactly one real WebSocket (to `/dmux`) for all of them. Device A's
    // sockets are tracked by the shim installed in `before`.
    it("carries every open document over a single /dmux socket", async function () {
      // Open several distinct docs at once (index + plugin DB are already live),
      // so multiple Yjs providers are active simultaneously.
      await writeNote(A, "Mux1.md", "one");
      await writeNote(A, "Mux2.md", "two");
      await writeNote(A, "Mux3.md", "three");
      await openNoteInEditor(A, "Mux1.md");
      await openNoteInEditor(A, "Mux2.md");
      await openNoteInEditor(A, "Mux3.md");

      let urls: string[] = [];
      await A.waitUntil(
        async () => {
          urls = await liveSocketUrls(A);
          return urls.filter((u) => u.includes("/dmux")).length === 1;
        },
        {
          timeout: 60 * SECONDS,
          timeoutMsg: () => `expected exactly one /dmux socket, saw ${JSON.stringify(urls)}`,
        },
      );

      // And the docs really synced through that one socket to device B.
      await B.waitUntil(async () => (await readNote(B, "Mux1.md")) === "one", {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never received Mux1.md over the mux",
      });
    });
  });

  describe("plugin SQL API", function () {
    it("propagates rows A <-> B over the Y log", async function () {
      await sqlOpen(A);
      await sqlOpen(B);

      await sqlInsert(A, "a1", "from-A");
      await sqlInsert(B, "b1", "from-B");

      // Both devices converge on both rows over the Y log.
      await A.waitUntil(async () => (await sqlTitles(A)).length === 2, {
        timeout: 60 * SECONDS,
        timeoutMsg: "A never saw both SQL rows",
      });
      await B.waitUntil(async () => (await sqlTitles(B)).length === 2, {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never saw both SQL rows",
      });
      expect(await sqlTitles(A)).toEqual(["from-A", "from-B"]);
      expect(await sqlTitles(B)).toEqual(["from-A", "from-B"]);
      expect(await sqlState(A)).toBe("live");
      expect(await sqlState(B)).toBe("live");
    });

    it("writes a deterministic SQL dump into the vault's git history", async function () {
      // Requires the server-side cr-sqlite extension; the harness wires it
      // through from CRSQLITE_EXT_PATH (see wdio.conf.mts).
      const gitDataDir = process.env.E2E_GIT_DATA_DIR;
      if (!process.env.CRSQLITE_EXT_PATH || !gitDataDir) this.skip();

      // The client's publish debounce calls /touch, which arms the server's
      // replication + git debounces; the commit then materializes the dump.
      const dumpPath = path.join(
        gitDataDir,
        vaultId,
        ".realtime",
        "plugin-dbs",
        SQL_E2E_IDS.pluginId,
        `${SQL_E2E_IDS.name}.sql`,
      );
      let lastSeen = "<missing>";
      await A.waitUntil(
        async () => {
          try {
            lastSeen = await fs.promises.readFile(dumpPath, "utf8");
          } catch {
            return false;
          }
          return lastSeen.includes("from-A") && lastSeen.includes("from-B");
        },
        {
          timeout: 90 * SECONDS,
          timeoutMsg: `git dump never materialized both rows at ${dumpPath}: ${lastSeen.slice(0, 400)}`,
        },
      );
      // The dump is restorable: user-table DDL + ordered INSERTs + CRR header.
      expect(lastSeen).toContain("CREATE TABLE tasks");
      expect(lastSeen).toContain("-- crr: tasks");
    });

    it("rebases a device from the server and converges to the same rows", async function () {
      // Discards B's local DB + snapshot and rebuilds through the real
      // bootstrap endpoint (replica-backed when the extension is installed,
      // Y-log fallback otherwise).
      await sqlRebaseFromServer(B);
      await B.waitUntil(
        async () => {
          const titles = await sqlTitles(B);
          return titles.length === 2 && (await sqlState(B)) === "live";
        },
        { timeout: 60 * SECONDS, timeoutMsg: "B did not recover both rows after rebase" },
      );
      expect(await sqlTitles(B)).toEqual(["from-A", "from-B"]);
    });

    it("soft-deletes into the shared trash bin on both devices", async function () {
      await sqlDelete(A);

      // The entry appears in the shared bin with the plugindb shape.
      const entryA = await sqlTrashEntryInfo(A);
      expect(entryA?.kind).toBe("plugindb");
      expect(entryA?.path).toBe(`${SQL_E2E_IDS.pluginId}/${SQL_E2E_IDS.name}`);
      expect(entryA?.pluginId).toBe(SQL_E2E_IDS.pluginId);
      expect(entryA?.name).toBe(SQL_E2E_IDS.name);
      await B.waitUntil(async () => await sqlHasTrashEntry(B), {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never saw the database in the trash bin",
      });

      // The tombstone propagates: B's open handle dies with the typed reason.
      await B.waitUntil(async () => (await sqlState(B)) === "error", {
        timeout: 60 * SECONDS,
        timeoutMsg: "B's open handle never saw the tombstone",
      });
    });

    it("restores from the trash bin and re-syncs on both devices", async function () {
      await sqlRestoreFromTrash(A);

      // The trash entry clears on both devices.
      expect(await sqlHasTrashEntry(A)).toBe(false);
      await B.waitUntil(async () => !(await sqlHasTrashEntry(B)), {
        timeout: 60 * SECONDS,
        timeoutMsg: "trash entry lingered on B after restore",
      });

      // A fresh open() on each device re-bootstraps with all rows intact —
      // including on B, whose previous engine was tombstoned.
      await sqlOpen(A);
      await A.waitUntil(async () => (await sqlTitles(A)).length === 2, {
        timeout: 60 * SECONDS,
        timeoutMsg: "A did not recover both rows after restore",
      });
      await sqlOpen(B);
      await B.waitUntil(async () => (await sqlTitles(B)).length === 2, {
        timeout: 60 * SECONDS,
        timeoutMsg: "B did not recover both rows after restore",
      });
      expect(await sqlTitles(A)).toEqual(["from-A", "from-B"]);
      expect(await sqlTitles(B)).toEqual(["from-A", "from-B"]);
      expect(await sqlState(A)).toBe("live");
      expect(await sqlState(B)).toBe("live");
    });
  });

  describe("live editing of an open note", function () {
    // Regression for the character-duplication bug: typing into an *open*
    // editor while a view-plugin teardown (mode switch) flushes Y.Text to a
    // disk that lags the editor made Obsidian report "modified externally and
    // changes have been merged in" and 3-way-merge the just-typed text back
    // into the buffer, duplicating characters (and re-sending them to peers).
    // The plain modify/read sync tests can't see this — only a real editor can.
    it("does not duplicate characters when editing through mode switches", async function () {
      const text = "The quick brown fox jumps over the lazy dog";

      await writeNote(A, "Live.md", "");
      await B.waitUntil(async () => (await readNote(B, "Live.md")) === "", {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never received the empty Live.md",
      });

      await openNoteInEditor(A, "Live.md");

      // Interleave typing with view-plugin teardowns while the disk lags the
      // editor (we never pause for Obsidian's autosave between type + toggle).
      await typeInEditor(A, "Live.md", "The quick brown fox ");
      await toggleSourceMode(A); // -> raw source: editor torn down + rebuilt
      await toggleSourceMode(A); // -> live preview: torn down + rebuilt again
      await typeInEditor(A, "Live.md", "jumps over the lazy dog");
      await toggleSourceMode(A);
      await toggleSourceMode(A);

      try {
        // The live editor buffer must be exactly what was typed — any
        // external-merge would have duplicated characters here. (Disk lags:
        // we never write while the file is open, so assert the buffer.)
        await A.waitUntil(async () => (await editorText(A, "Live.md")) === text, {
          timeout: 30 * SECONDS,
          timeoutMsg: `A's editor buffer was corrupted: "${await editorText(A, "Live.md")}"`,
        });
        // And the duplication must not have propagated: B converges to the
        // exact text, with no extra characters.
        await B.waitUntil(async () => (await readNote(B, "Live.md")) === text, {
          timeout: 60 * SECONDS,
          timeoutMsg: `B did not converge to the typed text: "${await readNote(B, "Live.md")}"`,
        });
        // Closing the only editor flushes the (clean) buffer to A's disk.
        await closeAllEditors(A);
        await A.waitUntil(async () => (await readNote(A, "Live.md")) === text, {
          timeout: 30 * SECONDS,
          timeoutMsg: `A's disk did not match after close: "${await readNote(A, "Live.md")}"`,
        });
      } finally {
        await closeAllEditors(A);
        await deleteNote(A, "Live.md");
      }
    });

    it("converges without duplicating when both devices edit the open note", async function () {
      // The collaborative case that stresses the editor↔Y.Text binding: both
      // devices have the note open and type concurrently. A binding that maps
      // CodeMirror offsets onto stale Y.Text positions duplicates characters
      // here; a self-healing diff binding converges to exactly the typed chars.
      await writeNote(A, "Co.md", "");
      await B.waitUntil(async () => (await readNote(B, "Co.md")) === "", {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never received the empty Co.md",
      });

      await openNoteInEditor(A, "Co.md");
      await openNoteInEditor(B, "Co.md");

      // Interleave keystrokes on both devices so remote applies and local
      // pushes land in the same editor update cycles.
      for (let i = 0; i < 6; i++) {
        await typeInEditor(A, "Co.md", "aa");
        await typeInEditor(B, "Co.md", "bb");
      }

      try {
        const expectedA = 12;
        const expectedB = 12;
        // Both editors must converge to the SAME text...
        let last = { a: "", b: "" };
        await A.waitUntil(
          async () => {
            last.a = (await editorText(A, "Co.md")) ?? "";
            last.b = (await editorText(B, "Co.md")) ?? "";
            return last.a.length > 0 && last.a === last.b;
          },
          {
            timeout: 60 * SECONDS,
            timeoutMsg: "editors never converged",
          },
        );
        // ...and that text must contain exactly the characters typed — no
        // duplicates (would be >12) and no losses (<12).
        const converged = last.a;
        const aCount = converged.split("").filter((c) => c === "a").length;
        const bCount = converged.split("").filter((c) => c === "b").length;
        expect(`${aCount}/${bCount}/${converged.length}`).toBe(
          `${expectedA}/${expectedB}/${expectedA + expectedB}`,
        );
      } finally {
        await closeAllEditors(A);
        await closeAllEditors(B);
        await deleteNote(A, "Co.md");
      }
    });
  });

  describe("canvas live binding", function () {
    // Canvases sync through a Y.Map CRDT, but while the file is open the disk
    // write-through is suppressed in favor of CanvasBinding (which patches the
    // canvas's private `requestSave`/`importData`). These tests drive the real
    // open canvas view so the binding — not the disk fallback — is under test.
    before(async function () {
      const a = await enableCorePlugin(A, "canvas");
      const b = await enableCorePlugin(B, "canvas");
      if (!a || !b) this.skip();

      await writeNote(A, "Board.canvas", canvasJson([canvasNode("n1", "hello")]));
      await B.waitUntil(async () => !!(await readNote(B, "Board.canvas"))?.includes("hello"), {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never received the seeded canvas",
      });

      await openFileInLeaf(A, "Board.canvas");
      await A.pause(SECONDS); // let the canvas view mount
      await bindOpenStructured(A); // ensure CanvasBinding is patched on
    });

    after(async function () {
      await detachLeaves(A, "canvas");
      await deleteNote(A, "Board.canvas").catch(() => {});
    });

    it("propagates a local edit made in A's open canvas to B", async function () {
      // Edit through the live canvas (patched requestSave -> captureLocal).
      await editCanvasView(A, "Board.canvas", {
        nodes: [canvasNode("n1", "edited-on-A"), canvasNode("n2", "added-on-A", 300)],
        edges: [],
      });
      await B.waitUntil(
        async () => {
          const disk = await readNote(B, "Board.canvas");
          return !!disk && disk.includes("edited-on-A") && disk.includes("added-on-A");
        },
        { timeout: 60 * SECONDS, timeoutMsg: "B never received A's live canvas edit" },
      );
    });

    it("applies a remote edit into A's open canvas view in place", async function () {
      // B is not viewing the canvas, so it writes via the disk path; the change
      // must land in A's *open* view via CanvasBinding.applyRemote (no reload).
      await writeNote(
        B,
        "Board.canvas",
        canvasJson([canvasNode("n1", "hello"), canvasNode("n3", "from-B-remote", 600)]),
      );
      await A.waitUntil(
        async () => {
          const data = await canvasViewData(A, "Board.canvas");
          const nodes = (data?.nodes ?? []) as Array<{ text?: string }>;
          return nodes.some((n) => n?.text === "from-B-remote");
        },
        { timeout: 60 * SECONDS, timeoutMsg: "A's open canvas view never showed B's remote node" },
      );
    });

    it("propagates an edge deletion from A's open canvas to B's disk", async function () {
      // Seed two nodes and an edge on A's open canvas.
      await editCanvasView(A, "Board.canvas", {
        nodes: [canvasNode("n1", "hello"), canvasNode("n3", "from-B-remote", 600)],
        edges: [canvasEdge("e1", "n1", "n3")],
      });
      await B.waitUntil(async () => !!(await readNote(B, "Board.canvas"))?.includes('"e1"'), {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never received the seeded edge",
      });

      // Delete the edge on A's open canvas.
      await editCanvasView(A, "Board.canvas", {
        nodes: [canvasNode("n1", "hello"), canvasNode("n3", "from-B-remote", 600)],
        edges: [],
      });
      await B.waitUntil(
        async () => {
          const disk = await readNote(B, "Board.canvas");
          return !!disk && !disk.includes('"e1"');
        },
        { timeout: 60 * SECONDS, timeoutMsg: "B's disk still has the deleted edge" },
      );
    });

    it("propagates a node deletion from A's open canvas to B's disk", async function () {
      // Delete n3 on A's open canvas.
      await editCanvasView(A, "Board.canvas", {
        nodes: [canvasNode("n1", "hello")],
        edges: [],
      });
      await B.waitUntil(
        async () => {
          const disk = await readNote(B, "Board.canvas");
          return !!disk && !disk.includes("from-B-remote");
        },
        { timeout: 60 * SECONDS, timeoutMsg: "B's disk still has the deleted node" },
      );
    });

    it("shows another device's cursor in an open canvas", async function () {
      // Open the canvas on B and bind so presence/cursor overlays mount.
      await openFileInLeaf(B, "Board.canvas");
      await B.pause(SECONDS); // let the canvas view mount
      await bindOpenStructured(B);

      // Dispatch a pointermove on B's canvas host to publish cursor coords.
      await dispatchCanvasPointerMove(B, "Board.canvas", 120, 80);

      // B signed in as "bob" — login adopts the SSO display name as the
      // cursor name unless the user customized it in settings.
      const bName = "bob";
      await A.waitUntil(
        async () => {
          const markers = await canvasPresenceMarkers(A, "Board.canvas");
          return markers.some(
            (m) => m.name === bName && m.x.trim() !== "" && m.y.trim() !== "",
          );
        },
        { timeout: 60 * SECONDS, timeoutMsg: "A never showed B's canvas cursor marker" },
      );

      // Clean up B's canvas leaf so it doesn't interfere with later tests.
      await detachLeaves(B, "canvas");
    });
  });

  describe("canvas deletion propagation to an open view", function () {
    // Regression suite for the deleted-edge-not-propagating bug: A deletes an
    // edge/node while B has the same canvas open. The delete must land in B's
    // *live view* (not just disk), and B's subsequent local edits must not
    // resurrect the deleted item via a stale full-snapshot capture.
    before(async function () {
      const a = await enableCorePlugin(A, "canvas");
      const b = await enableCorePlugin(B, "canvas");
      if (!a || !b) this.skip();
    });

    beforeEach(async function () {
      await detachLeaves(A, "canvas");
      await detachLeaves(B, "canvas");
      await writeNote(
        A,
        "DelBoard.canvas",
        canvasJson(
          [canvasNode("a1", "alpha", 0), canvasNode("b1", "beta", 300)],
          [canvasEdge("edge1", "a1", "b1")],
        ),
      );
      await B.waitUntil(async () => !!(await readNote(B, "DelBoard.canvas"))?.includes('"edge1"'), {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never received the seeded DelBoard",
      });
    });

    after(async function () {
      await detachLeaves(A, "canvas");
      await detachLeaves(B, "canvas");
      await deleteNote(A, "DelBoard.canvas").catch(() => {});
    });

    it("lands a remote edge deletion into B's open canvas view", async function () {
      await openFileInLeaf(B, "DelBoard.canvas");
      await B.pause(SECONDS); // let the canvas view mount
      await bindOpenStructured(B);

      // A (not viewing) deletes the edge via disk write.
      await writeNote(
        A,
        "DelBoard.canvas",
        canvasJson([canvasNode("a1", "alpha", 0), canvasNode("b1", "beta", 300)], []),
      );
      await B.waitUntil(
        async () => {
          const data = await canvasViewData(B, "DelBoard.canvas");
          const edges = (data?.edges ?? []) as Array<{ id?: string }>;
          return !edges.some((e) => e?.id === "edge1");
        },
        { timeout: 60 * SECONDS, timeoutMsg: "B's open view still has the deleted edge" },
      );
    });

    it("does not resurrect a deleted edge when B makes a local edit on the open canvas", async function () {
      // B opens the canvas; A deletes the edge; then B edits a node locally.
      // B's local capture must NOT re-insert the deleted edge.
      await openFileInLeaf(B, "DelBoard.canvas");
      await B.pause(SECONDS);
      await bindOpenStructured(B);

      // A deletes the edge.
      await writeNote(
        A,
        "DelBoard.canvas",
        canvasJson([canvasNode("a1", "alpha", 0), canvasNode("b1", "beta", 300)], []),
      );
      // Wait for B's view to reflect the deletion.
      await B.waitUntil(
        async () => {
          const data = await canvasViewData(B, "DelBoard.canvas");
          const edges = (data?.edges ?? []) as Array<{ id?: string }>;
          return !edges.some((e) => e?.id === "edge1");
        },
        { timeout: 60 * SECONDS, timeoutMsg: "B's open view never dropped the deleted edge" },
      );

      // B makes a local edit (moves a node) — its full snapshot must not
      // resurrect edge1.
      await editCanvasView(B, "DelBoard.canvas", {
        nodes: [canvasNode("a1", "alpha", 500), canvasNode("b1", "beta", 300)],
        edges: [],
      });
      await A.waitUntil(
        async () => {
          const disk = await readNote(A, "DelBoard.canvas");
          return !!disk && disk.includes('"a1"') && !disk.includes('"edge1"');
        },
        { timeout: 60 * SECONDS, timeoutMsg: "A's disk shows the resurrected edge" },
      );
    });

    it("does not resurrect a deleted edge when B captures a stale snapshot that still contains it", async function () {
      // This is the core tombstone test: B's view has NOT yet applied the
      // remote delete (e.g. slow binding), so B's captured snapshot still
      // contains the edge. The tombstone in the CRDT must block re-insertion.
      await openFileInLeaf(B, "DelBoard.canvas");
      await B.pause(SECONDS);
      await bindOpenStructured(B);

      // A deletes the edge.
      await writeNote(
        A,
        "DelBoard.canvas",
        canvasJson([canvasNode("a1", "alpha", 0), canvasNode("b1", "beta", 300)], []),
      );
      // Wait for the CRDT to sync to B (disk converges), but DON'T wait for
      // B's view — we want to capture the window where B's view is stale.
      await B.waitUntil(
        async () => {
          const disk = await readNote(B, "DelBoard.canvas");
          return !!disk && !disk.includes('"edge1"');
        },
        { timeout: 60 * SECONDS, timeoutMsg: "B's disk never dropped the edge" },
      );

      // B captures a stale snapshot (simulated by editing the view with the
      // edge still present — the test helper calls importData then requestSave).
      // The tombstone must prevent edge1 from re-entering the CRDT.
      await editCanvasView(B, "DelBoard.canvas", {
        nodes: [canvasNode("a1", "alpha", 0), canvasNode("b1", "beta", 300)],
        edges: [canvasEdge("edge1", "a1", "b1")],
      });

      // Give the sync a moment to propagate, then verify the edge is still
      // gone on A (not resurrected).
      await B.pause(2 * SECONDS);
      const diskA = await readNote(A, "DelBoard.canvas");
      expect(diskA).toBeTruthy();
      expect(diskA).not.toContain('"edge1"');
    });

    it("lands a remote node deletion into B's open canvas view", async function () {
      await openFileInLeaf(B, "DelBoard.canvas");
      await B.pause(SECONDS);
      await bindOpenStructured(B);

      // A deletes node b1.
      await writeNote(A, "DelBoard.canvas", canvasJson([canvasNode("a1", "alpha", 0)], []));
      await B.waitUntil(
        async () => {
          const data = await canvasViewData(B, "DelBoard.canvas");
          const nodes = (data?.nodes ?? []) as Array<{ id?: string }>;
          return !nodes.some((n) => n?.id === "b1");
        },
        { timeout: 60 * SECONDS, timeoutMsg: "B's open view still has the deleted node" },
      );
    });

    it("allows same-device undo: A deletes an edge then re-adds it, and the re-add propagates to B", async function () {
      // Regression for the tombstone-undo interaction: A deletes edge1, then
      // A re-adds it (simulating undo). Because A created the tombstone, A's
      // re-add clears it and the edge syncs back to B.
      await writeNote(
        A,
        "DelBoard.canvas",
        canvasJson(
          [canvasNode("a1", "alpha", 0), canvasNode("b1", "beta", 300)],
          [canvasEdge("edge1", "a1", "b1")],
        ),
      );
      await B.waitUntil(async () => !!(await readNote(B, "DelBoard.canvas"))?.includes('"edge1"'), {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never received the initial edge",
      });

      // A deletes the edge via disk write.
      await writeNote(
        A,
        "DelBoard.canvas",
        canvasJson([canvasNode("a1", "alpha", 0), canvasNode("b1", "beta", 300)], []),
      );
      await B.waitUntil(
        async () => {
          const disk = await readNote(B, "DelBoard.canvas");
          return !!disk && !disk.includes('"edge1"');
        },
        { timeout: 60 * SECONDS, timeoutMsg: "B never saw the edge deletion" },
      );

      // A re-adds the edge (undo). Same device → tombstone clears → edge returns.
      await writeNote(
        A,
        "DelBoard.canvas",
        canvasJson(
          [canvasNode("a1", "alpha", 0), canvasNode("b1", "beta", 300)],
          [canvasEdge("edge1", "a1", "b1")],
        ),
      );
      await B.waitUntil(async () => !!(await readNote(B, "DelBoard.canvas"))?.includes('"edge1"'), {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never received the re-added edge (undo blocked by tombstone)",
      });
    });
  });

  describe("base live binding", function () {
    // Bases are a TextFileView, so BaseBinding hooks the standard
    // getViewData/setViewData/requestSave instead of a private API. Skipped on
    // Obsidian builds that predate the Bases core plugin.
    before(async function () {
      const a = await enableCorePlugin(A, "bases");
      const b = await enableCorePlugin(B, "bases");
      if (!a || !b) this.skip();

      await writeNote(A, "Tracker.base", baseYaml("Initial"));
      await B.waitUntil(async () => !!(await readNote(B, "Tracker.base"))?.includes("Initial"), {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never received the seeded base",
      });

      await openFileInLeaf(A, "Tracker.base");
      await A.pause(SECONDS); // let the base view mount
      await bindOpenStructured(A); // ensure BaseBinding is patched on
    });

    after(async function () {
      await detachLeaves(A, "bases");
      await deleteNote(A, "Tracker.base").catch(() => {});
    });

    it("propagates a local edit made in A's open base to B", async function () {
      // Edit through the live base view (patched requestSave -> captureLocal).
      await editBaseView(A, "Tracker.base", baseYaml("EditedOnA"));
      await B.waitUntil(async () => !!(await readNote(B, "Tracker.base"))?.includes("EditedOnA"), {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never received A's live base edit",
      });
    });

    it("applies a remote edit into A's open base view in place", async function () {
      await writeNote(B, "Tracker.base", baseYaml("FromBRemote"));
      await A.waitUntil(
        async () => !!(await baseViewData(A, "Tracker.base"))?.includes("FromBRemote"),
        { timeout: 60 * SECONDS, timeoutMsg: "A's open base view never showed B's remote edit" },
      );
    });
  });

  describe("offline divergence -> conflict resolution", function () {
    // Model "offline & not tracking" by disabling the plugin, editing the file
    // externally, then re-enabling it. The current text conflict flow resolves to
    // one canonical version and must not create/sync legacy conflicted-copy files.
    it("converges without syncing conflicted-copy files", async function () {
      await writeNote(A, "Conflict.md", "base");
      await B.waitUntil(async () => (await readNote(B, "Conflict.md")) === "base", {
        timeout: 60 * SECONDS,
        timeoutMsg: "baseline never reached B",
      });
      await A.pause(SECONDS); // persist baseline to A's IndexedDB

      await setPluginEnabled(A, false); // A goes offline & stops tracking

      await writeNote(A, "Conflict.md", "base + LOCAL while offline");
      await writeNote(B, "Conflict.md", "base + REMOTE online");
      await B.pause(2 * SECONDS); // let B sync to the server

      await setPluginEnabled(A, true); // A restarts -> startup reconcile + conflict

      await A.waitUntil(
        async () => {
          const a = await readNote(A, "Conflict.md");
          const b = await readNote(B, "Conflict.md");
          return !!a && !!b && a === b;
        },
        { timeout: 60 * SECONDS, timeoutMsg: "devices did not converge" },
      );

      const canonical = await readNote(A, "Conflict.md");
      expect(["base + LOCAL while offline", "base + REMOTE online"]).toContain(canonical);

      // Scope to Conflict.md (the file under test) so unrelated files can't
      // influence the assertion.
      const isConflictCopy = (p: string) => /^Conflict \(conflicted copy .+\)\.md$/.test(p);
      const aCopies = (await listMarkdown(A)).filter(isConflictCopy);
      const bCopies = (await listMarkdown(B)).filter(isConflictCopy);
      expect(aCopies.length).toBe(0);
      expect(bCopies.length).toBe(0);
    });
  });

  describe("network drop -> reconnect", function () {
    // Cuts device A's network at the WebSocket layer (see installNetworkShim),
    // then restores it, asserting the plugin drops out of "live" and recovers.
    it("recovers connectivity and resumes sync after a network drop", async function () {
      await setNetworkOffline(A, true);
      await A.waitUntil(async () => !/live/i.test(await statusText(A)), {
        timeout: 30 * SECONDS,
        timeoutMsg: "A still 'live' after the network was cut",
      });

      await setNetworkOffline(A, false);
      await A.waitUntil(async () => /live/i.test(await statusText(A)), {
        timeout: 60 * SECONDS,
        timeoutMsg: "A did not return to 'live' after the network was restored",
      });

      await writeNote(B, "Reconnect.md", "after reconnect");
      await A.waitUntil(async () => (await readNote(A, "Reconnect.md")) === "after reconnect", {
        timeout: 60 * SECONDS,
        timeoutMsg: "sync did not resume after reconnect",
      });
    });
  });

  describe("vault administration", function () {
    it("allows admins to remove members but not admins", async function () {
      const bobMe = await fetch(`${authUrl}/api/me`, {
        headers: { Authorization: `Bearer ${bobToken}` },
      }).then((res) => res.json() as Promise<{ userId: string }>);
      await apiPromoteMember(authUrl, adminToken, vaultId, bobMe.userId);

      const charlie = await mockLogin(authUrl, "charlie");
      const charlieMe = await fetch(`${authUrl}/api/me`, {
        headers: { Authorization: `Bearer ${charlie}` },
      }).then((res) => res.json() as Promise<{ userId: string }>);
      await apiRedeemInvite(authUrl, charlie, await generateInvite(authUrl, adminToken, vaultId));
      expect(await apiRemoveMember(authUrl, bobToken, vaultId, charlieMe.userId)).toBe(200);

      const dave = await mockLogin(authUrl, "dave");
      const daveMe = await fetch(`${authUrl}/api/me`, {
        headers: { Authorization: `Bearer ${dave}` },
      }).then((res) => res.json() as Promise<{ userId: string }>);
      await apiRedeemInvite(authUrl, dave, await generateInvite(authUrl, adminToken, vaultId));
      await apiPromoteMember(authUrl, adminToken, vaultId, daveMe.userId);
      expect(await apiRemoveMember(authUrl, bobToken, vaultId, daveMe.userId)).toBe(403);
    });

    it("allows the owner to remove an admin and revokes that device's access", async function () {
      const bobMe = await fetch(`${authUrl}/api/me`, {
        headers: { Authorization: `Bearer ${bobToken}` },
      }).then((res) => res.json() as Promise<{ userId: string }>);
      expect(await apiRemoveMember(authUrl, adminToken, vaultId, bobMe.userId)).toBe(200);
      expect(await docTokenStatus(B, vaultId)).toBe("refused");
    });
  });

  describe("trash", function () {
    // Each test is self-contained: it writes, deletes, asserts, and cleans up.
    // The vault administration suite removed bob (device B), so we re-admit B
    // here and wait for both devices to be live again before exercising the
    // trash sync assertions across the two devices.
    before(async function () {
      const code = await generateInvite(authUrl, adminToken, vaultId);
      await redeemInviteOnly(B, code);
      await reloadSync(B);
      for (const [label, dev] of [
        ["A", A],
        ["B", B],
      ] as const) {
        let last = "";
        await dev.waitUntil(
          async () => {
            last = await statusText(dev);
            return /live/i.test(last);
          },
          {
            timeout: 90 * SECONDS,
            timeoutMsg: `${label} never returned to 'live' before trash tests (last status: ${last})`,
          },
        );
      }
    });

    it("deleting a note records a trash entry that syncs to the remote device", async function () {
      await writeNote(A, "Trashable.md", "trash me");
      await B.waitUntil(async () => (await readNote(B, "Trashable.md")) === "trash me", {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never received Trashable.md before delete",
      });

      await deleteNote(A, "Trashable.md");

      // The entry must appear in the shared trash on device B.
      let trashId: string | undefined;
      await B.waitUntil(
        async () => {
          const entries: any[] = await listTrash(B);
          const entry = entries.find((e: any) => e.path === "Trashable.md");
          if (entry) trashId = entry.id;
          return !!entry;
        },
        { timeout: 60 * SECONDS, timeoutMsg: "B never saw Trashable.md in trash" },
      );

      // Permanently delete so we don't pollute subsequent tests.
      await permanentlyDeleteTrashEntry(A, trashId!);
      await B.waitUntil(
        async () => !(await listTrash(B)).some((e: any) => e.path === "Trashable.md"),
        {
          timeout: 30 * SECONDS,
          timeoutMsg: "trash entry did not disappear from B after permanent delete",
        },
      );
    });

    it("restoring a trashed note makes the file reappear on both devices", async function () {
      await writeNote(A, "Restore.md", "restore me");
      await B.waitUntil(async () => (await readNote(B, "Restore.md")) === "restore me", {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never received Restore.md",
      });

      await deleteNote(A, "Restore.md");
      let trashId: string | undefined;
      await A.waitUntil(
        async () => {
          const entries: any[] = await listTrash(A);
          const entry = entries.find((e: any) => e.path === "Restore.md");
          if (entry) trashId = entry.id;
          return !!entry;
        },
        { timeout: 30 * SECONDS, timeoutMsg: "A never saw Restore.md in trash" },
      );

      await restoreTrashEntry(A, trashId!);

      // File should reappear on A...
      await A.waitUntil(async () => (await readNote(A, "Restore.md")) !== null, {
        timeout: 30 * SECONDS,
        timeoutMsg: "Restore.md did not reappear on A",
      });
      // ...and propagate to B.
      await B.waitUntil(async () => (await readNote(B, "Restore.md")) !== null, {
        timeout: 60 * SECONDS,
        timeoutMsg: "Restore.md did not reappear on B",
      });
      // Trash entry must be gone from both devices.
      expect((await listTrash(A)).some((e: any) => e.path === "Restore.md")).toBe(false);
      await B.waitUntil(
        async () => !(await listTrash(B)).some((e: any) => e.path === "Restore.md"),
        { timeout: 30 * SECONDS, timeoutMsg: "trash entry lingered on B after restore" },
      );

      // Cleanup.
      await deleteNote(A, "Restore.md");
      const leftovers: any[] = await listTrash(A);
      const leftover = leftovers.find((e: any) => e.path === "Restore.md");
      if (leftover) await permanentlyDeleteTrashEntry(A, leftover.id);
    });

    it("restore under a new path places the file at that path on both devices", async function () {
      await writeNote(A, "Original.md", "original content");
      await B.waitUntil(async () => (await readNote(B, "Original.md")) === "original content", {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never received Original.md",
      });

      await deleteNote(A, "Original.md");
      let trashId: string | undefined;
      await A.waitUntil(
        async () => {
          const entries: any[] = await listTrash(A);
          const entry = entries.find((e: any) => e.path === "Original.md");
          if (entry) trashId = entry.id;
          return !!entry;
        },
        { timeout: 30 * SECONDS, timeoutMsg: "A never saw Original.md in trash" },
      );

      await restoreTrashEntry(A, trashId!, "RestoredAs.md");

      // Old path must remain absent; new path must appear on both devices.
      await A.waitUntil(async () => (await readNote(A, "RestoredAs.md")) !== null, {
        timeout: 30 * SECONDS,
        timeoutMsg: "RestoredAs.md did not appear on A",
      });
      expect(await readNote(A, "Original.md")).toBe(null);
      await B.waitUntil(async () => (await readNote(B, "RestoredAs.md")) !== null, {
        timeout: 60 * SECONDS,
        timeoutMsg: "RestoredAs.md did not propagate to B",
      });
      expect(await readNote(B, "Original.md")).toBe(null);

      // Cleanup.
      await deleteNote(A, "RestoredAs.md");
      const leftovers: any[] = await listTrash(A);
      const leftover = leftovers.find((e: any) => e.path === "RestoredAs.md");
      if (leftover) await permanentlyDeleteTrashEntry(A, leftover.id);
    });

    it("permanently deleting a trash entry removes it from the shared trash on both devices", async function () {
      await writeNote(A, "PermanentDelete.md", "gone for good");
      await B.waitUntil(async () => (await readNote(B, "PermanentDelete.md")) === "gone for good", {
        timeout: 60 * SECONDS,
        timeoutMsg: "B never received PermanentDelete.md",
      });

      await deleteNote(A, "PermanentDelete.md");
      let trashId: string | undefined;
      await A.waitUntil(
        async () => {
          const entries: any[] = await listTrash(A);
          const entry = entries.find((e: any) => e.path === "PermanentDelete.md");
          if (entry) trashId = entry.id;
          return !!entry;
        },
        { timeout: 30 * SECONDS, timeoutMsg: "A never saw PermanentDelete.md in trash" },
      );

      await permanentlyDeleteTrashEntry(A, trashId!);

      // Entry must disappear from A immediately...
      expect((await listTrash(A)).some((e: any) => e.path === "PermanentDelete.md")).toBe(false);
      // ...and sync off B.
      await B.waitUntil(
        async () => !(await listTrash(B)).some((e: any) => e.path === "PermanentDelete.md"),
        { timeout: 60 * SECONDS, timeoutMsg: "permanent-deleted entry did not disappear from B" },
      );
    });
  });

  describe("storage API", function () {
    // These are pure Node-side REST calls — no Obsidian instance required.
    // The harness starts y-sweet with --storage so plainVaultBytes is a real
    // non-negative number rather than null.

    it("returns a valid storage breakdown with the expected shape", async function () {
      const res = await fetch(`${authUrl}/api/vaults/${vaultId}/storage`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.blobsCurrentBytes).toBe("number");
      expect(typeof body.blobsPreviousBytes).toBe("number");
      expect(typeof body.currentBlobCount).toBe("number");
      expect(typeof body.previousBlobCount).toBe("number");
      // plainVaultBytes is a number because YSWEET_STORE is wired in the test harness.
      expect(typeof body.plainVaultBytes).toBe("number");
      expect((body.plainVaultBytes as number) >= 0).toBe(true);
    });

    it("gc-blobs returns zero freed bytes when nothing is orphaned", async function () {
      const res = await fetch(`${authUrl}/api/vaults/${vaultId}/storage/gc-blobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.removed).toBe("number");
      expect(typeof body.freedBytes).toBe("number");
      expect(body.removed).toBe(0);
      expect(body.freedBytes).toBe(0);
    });
  });
});
