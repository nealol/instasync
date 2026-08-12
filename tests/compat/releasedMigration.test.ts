import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { YSweetProvider } from "@y-sweet/client";
import { DocumentManager } from "@y-sweet/sdk";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import {
  RealtimeProvider,
  SYNC_STATUS_CONNECTED,
  type SyncSocket,
} from "../../src/sync/RealtimeProvider";
import type { ClientToken as NativeClientToken } from "../../src/sync/clientToken";
import { apiCreateVault, mockLogin, startAuthServer, type AuthServer } from "../support/authServer";
import { waitFor } from "../support/util";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const ySweetExecutable = join(repositoryRoot, "node_modules", "y-sweet", "bin", "y-sweet");
const serverExecutable = join(
  repositoryRoot,
  "server",
  "target",
  "debug",
  process.platform === "win32" ? "realtime-server.exe" : "realtime-server",
);
const privateKey = "QPMjc_R5o-0dJvgjwnFKmeBfDZqHbxyFWn7Q51TI";
const serverToken = "AAAgLTRZTpXgngCgxdfxi7UYq_y33DgpdgvL_OaGggUnbX0";

let currentServer: AuthServer | null = null;
let releasedServer: ChildProcess | null = null;
let temporaryRoot: string | null = null;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve test port");
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

async function stopProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolveStopped) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolveStopped();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStopped();
    });
    child.kill("SIGTERM");
  });
}

async function startReleasedYSweet(store: string): Promise<{ manager: DocumentManager }> {
  const port = await freePort();
  releasedServer = spawn(
    ySweetExecutable,
    [
      "serve",
      store,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--auth",
      privateKey,
      "--url-prefix",
      `http://127.0.0.1:${port}`,
      "--checkpoint-freq-seconds",
      "1",
      "--prod",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const output: string[] = [];
  releasedServer.stdout?.on("data", (chunk) => output.push(String(chunk)));
  releasedServer.stderr?.on("data", (chunk) => output.push(String(chunk)));
  const manager = new DocumentManager(`ys://${serverToken}@127.0.0.1:${port}`);
  await waitFor(
    async () => {
      if (releasedServer?.exitCode !== null) {
        throw new Error(`released y-sweet exited early:\n${output.join("")}`);
      }
      try {
        return (await manager.checkStore()).ok;
      } catch {
        return false;
      }
    },
    { timeout: 30_000, label: "released y-sweet readiness" },
  );
  return { manager };
}

async function nativeToken(
  serverUrl: string,
  sessionToken: string,
  vaultId: string,
): Promise<NativeClientToken> {
  const response = await fetch(`${serverUrl}/api/doc-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ vaultId, docId: vaultId }),
  });
  if (!response.ok) throw new Error(`native document token failed: HTTP ${response.status}`);
  return (await response.json()) as NativeClientToken;
}

function nativeProvider(docId: string, doc: Y.Doc, token: NativeClientToken): RealtimeProvider {
  return new RealtimeProvider(docId, doc, async () => token, {
    socketFactory: (url) => new WebSocket(url) as unknown as SyncSocket,
  });
}

afterEach(async () => {
  await currentServer?.stop();
  currentServer = null;
  await stopProcess(releasedServer);
  releasedServer = null;
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = null;
});

describe("released y-sweet to native server migration", () => {
  it("preserves released-client writes through import, native sync, and restart", async () => {
    (globalThis as { window?: unknown }).window = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      setTimeout,
      clearTimeout,
    };
    const releasedPackage = JSON.parse(
      readFileSync(
        join(repositoryRoot, "node_modules", "@y-sweet", "client", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(releasedPackage.version).toBe("0.9.1");

    temporaryRoot = mkdtempSync(join(tmpdir(), "realtime-cross-version-"));
    const databasePath = join(temporaryRoot, "server.db");
    const nativeStore = join(temporaryRoot, "native-crdt");
    const releasedStore = join(temporaryRoot, "ysweet");

    currentServer = await startAuthServer({ databasePath, crdtStoreDir: nativeStore });
    const sessionToken = await mockLogin(currentServer.url, "compat-user");
    const vault = await apiCreateVault(currentServer.url, sessionToken, "cross-version");
    await currentServer.stop();
    currentServer = null;
    // Vault creation on the current binary initializes an empty native index.
    // A real pre-native database has no native store, so discard that bootstrap
    // artifact before importing the legacy server's authoritative document.
    rmSync(nativeStore, { recursive: true, force: true });

    const { manager } = await startReleasedYSweet(releasedStore);
    const releasedToken = await manager.getOrCreateDocAndToken(vault.id, { authorization: "full" });
    const releasedDoc = new Y.Doc();
    const releasedDataPath = join(releasedStore, vault.id, "data.ysweet");
    await waitFor(() => existsSync(releasedDataPath), { label: "released store initialization" });
    const beforeReleasedWrite = readFileSync(releasedDataPath);
    const releasedProvider = new YSweetProvider(async () => releasedToken, vault.id, releasedDoc, {
      connect: false,
      initialClientToken: releasedToken,
      WebSocketPolyfill: WebSocket,
      showDebuggerLink: false,
    });
    try {
      await releasedProvider.connect();
      await waitFor(() => releasedProvider.status === "connected", {
        label: "released provider handshake",
      });
      releasedDoc.getMap("compatibility").set("releasedWrite", "durable-before-migration");
      await waitFor(() => !releasedProvider.hasLocalChanges, {
        label: "released write acknowledgement",
      });
      await waitFor(() => !readFileSync(releasedDataPath).equals(beforeReleasedWrite), {
        label: "released write checkpoint",
      });
      await waitFor(
        async () => {
          const persisted = new Y.Doc();
          Y.applyUpdate(persisted, await manager.getDocAsUpdate(vault.id));
          return (
            persisted.getMap("compatibility").get("releasedWrite") === "durable-before-migration"
          );
        },
        { label: "released store durability" },
      );
    } finally {
      releasedProvider.destroy();
    }
    await stopProcess(releasedServer);
    releasedServer = null;
    expect(existsSync(join(releasedStore, vault.id, "data.ysweet"))).toBe(true);

    const importReport = JSON.parse(
      execFileSync(serverExecutable, ["crdt", "import-ysweet", releasedStore, nativeStore], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as { imported: string[]; errors: string[] };
    expect(importReport.errors).toEqual([]);
    expect(importReport.imported).toContain(vault.id);

    currentServer = await startAuthServer({ databasePath, crdtStoreDir: nativeStore });
    const firstToken = await nativeToken(currentServer.url, sessionToken, vault.id);
    const nativeDoc = new Y.Doc();
    const firstProvider = nativeProvider(vault.id, nativeDoc, firstToken);
    try {
      try {
        await waitFor(
          () =>
            firstProvider.status === SYNC_STATUS_CONNECTED &&
            nativeDoc.getMap("compatibility").get("releasedWrite") === "durable-before-migration",
          { label: "native provider loaded migrated write" },
        );
      } catch (error) {
        throw new Error(
          `native migration load failed: status=${firstProvider.status} connectionError=${firstProvider.lastConnectionError} value=${String(nativeDoc.getMap("compatibility").get("releasedWrite"))}`,
          { cause: error },
        );
      }
      nativeDoc.getMap("compatibility").set("nativeWrite", "durable-after-migration");
      await waitFor(() => !firstProvider.hasLocalChanges, {
        label: "native write acknowledgement",
      });
    } finally {
      firstProvider.destroy();
    }
    await currentServer.stop();
    currentServer = null;

    currentServer = await startAuthServer({ databasePath, crdtStoreDir: nativeStore });
    const restartToken = await nativeToken(currentServer.url, sessionToken, vault.id);
    const restartedDoc = new Y.Doc();
    const restartedProvider = nativeProvider(vault.id, restartedDoc, restartToken);
    try {
      await waitFor(
        () => {
          const values = restartedDoc.getMap("compatibility");
          return (
            restartedProvider.status === SYNC_STATUS_CONNECTED &&
            values.get("releasedWrite") === "durable-before-migration" &&
            values.get("nativeWrite") === "durable-after-migration"
          );
        },
        { label: "post-migration restart durability" },
      );
    } finally {
      restartedProvider.destroy();
    }
  }, 120_000);
});
