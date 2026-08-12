// Cross-runtime conformance and deterministic transport-chaos coverage.
//
// Every client uses Yjs with Realtime's native provider. The peer is the Rust
// yrs engine. The socket wrapper deterministically delays, reorders, and
// duplicates binary frames; the restart scenario kills the server process after
// an acknowledged write, edits while partitioned, and reconnects to the same
// database and CRDT store.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as Y from "yjs";
import { RealtimeProvider, type SyncSocket } from "../../src/sync/RealtimeProvider";
import { makeFakePlugin, type FakePlugin } from "../support/fakePlugin";
import {
  apiCreateVault,
  mockLogin,
  startAuthHarness,
  startAuthServer,
  type AuthHarness,
  type AuthServer,
} from "../support/authServer";
import { freshGuid, waitFor } from "../support/util";
import {
  getClientToken,
  resetTokenRetryStateForTests,
  type ClientToken,
} from "../../src/sync/clientToken";

const RealWebSocket = globalThis.WebSocket as unknown as {
  new (url: string | URL): WebSocket;
};

/**
 * Minimal socket facade used by RealtimeProvider. Binary frames take a
 * reproducible path through a slow, reordering, duplicating network. Control
 * events are not disturbed, so every run reaches the same protocol states.
 */
class DeterministicChaosSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: DeterministicChaosSocket[] = [];
  static pendingDeliveries = 0;
  static nextSeed = 0x5eed1234;
  static paused = false;
  private static deliveries: Array<{ order: number; deliver: () => unknown }> = [];
  private static flushScheduled = false;
  private static idleWaiters: Array<() => void> = [];

  readonly inner: WebSocket;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  private sequence = 0;
  private seed: number;
  private closed = false;

  constructor(url: string | URL) {
    this.seed = DeterministicChaosSocket.nextSeed++;
    this.inner = new RealWebSocket(url);
    this.inner.binaryType = "arraybuffer";
    DeterministicChaosSocket.instances.push(this);
    this.inner.onopen = (event) => this.onopen?.(event);
    this.inner.onerror = (event) => this.onerror?.(event);
    this.inner.onclose = (event) => {
      this.closed = true;
      this.onclose?.(event);
    };
    this.inner.onmessage = (event) => {
      this.transit(() => this.onmessage?.(event));
      if (++this.sequence % 7 === 0) {
        this.transit(() => this.onmessage?.(event), 19);
      }
    };
  }

  get url(): string {
    return this.inner.url;
  }

  get readyState(): number {
    return this.inner.readyState;
  }

  get bufferedAmount(): number {
    return this.inner.bufferedAmount;
  }

  get extensions(): string {
    return this.inner.extensions;
  }

  get protocol(): string {
    return this.inner.protocol;
  }

  get binaryType(): BinaryType {
    return this.inner.binaryType;
  }

  set binaryType(value: BinaryType) {
    this.inner.binaryType = value;
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const sequence = ++this.sequence;
    this.transit(() => {
      if (this.inner.readyState === DeterministicChaosSocket.OPEN) {
        this.inner.send(data);
      }
    });
    if (sequence % 5 === 0) {
      this.transit(() => {
        if (this.inner.readyState === DeterministicChaosSocket.OPEN) {
          this.inner.send(data);
        }
      }, 23);
    }
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.inner.close(code, reason);
  }

  addEventListener(...args: Parameters<WebSocket["addEventListener"]>): void {
    this.inner.addEventListener(...args);
  }

  removeEventListener(...args: Parameters<WebSocket["removeEventListener"]>): void {
    this.inner.removeEventListener(...args);
  }

  dispatchEvent(event: Event): boolean {
    return this.inner.dispatchEvent(event);
  }

  private transit(deliver: () => unknown, extraDelay = 0): void {
    this.seed ^= this.seed << 13;
    this.seed ^= this.seed >>> 17;
    this.seed ^= this.seed << 5;
    DeterministicChaosSocket.pendingDeliveries++;
    DeterministicChaosSocket.deliveries.push({
      order: ((this.seed >>> 0) % 31) + extraDelay,
      deliver: () => {
        try {
          if (!this.closed) deliver();
        } finally {
          DeterministicChaosSocket.pendingDeliveries--;
        }
      },
    });
    DeterministicChaosSocket.scheduleFlush();
  }

  static reset(): void {
    this.instances = [];
    this.pendingDeliveries = 0;
    this.nextSeed = 0x5eed1234;
    this.paused = false;
    this.deliveries = [];
    this.flushScheduled = false;
    this.idleWaiters = [];
  }

  static pause(): void {
    this.paused = true;
  }

  static release(): void {
    this.paused = false;
    this.scheduleFlush();
  }

  static async whenIdle(): Promise<void> {
    if (this.pendingDeliveries === 0) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.idleWaiters.push(resolve);
    await promise;
  }

  private static scheduleFlush(): void {
    if (this.paused || this.flushScheduled || this.deliveries.length === 0) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (this.paused) return;
      const batch = this.deliveries.splice(0).sort((left, right) => right.order - left.order);
      for (const { deliver } of batch) deliver();
      if (this.deliveries.length > 0) this.scheduleFlush();
      if (this.pendingDeliveries === 0) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    });
  }
}

interface Client {
  doc: Y.Doc;
  map: Y.Map<string>;
  awareness: RealtimeProvider["awareness"];
  provider: RealtimeProvider;
  destroy: () => void;
}

function client(plugin: FakePlugin, documentId: string, token?: ClientToken): Client {
  const doc = new Y.Doc();
  const provider = new RealtimeProvider(
    documentId,
    doc,
    () =>
      token
        ? Promise.resolve(token)
        : getClientToken(plugin as unknown as Parameters<typeof getClientToken>[0], documentId),
    {
      socketFactory: (url) => new DeterministicChaosSocket(url) as unknown as SyncSocket,
    },
  );
  return {
    doc,
    map: doc.getMap<string>("chaos"),
    awareness: provider.awareness,
    provider,
    destroy: () => {
      provider.destroy();
      doc.destroy();
    },
  };
}

async function readOnlyToken(
  authUrl: string,
  sessionToken: string,
  vaultId: string,
  documentId: string,
): Promise<ClientToken> {
  const response = await fetch(`${authUrl}/api/doc-token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ vaultId, docId: documentId, authorization: "read-only" }),
  });
  if (!response.ok) throw new Error(`read-only token request failed: ${response.status}`);
  return (await response.json()) as ClientToken;
}

async function serverSnapshot(plugin: FakePlugin, documentId: string): Promise<Y.Doc> {
  const token = await getClientToken(
    plugin as unknown as Parameters<typeof getClientToken>[0],
    documentId,
  );
  const response = await fetch(`${token.baseUrl}/as-update`, {
    headers: { authorization: `Bearer ${token.token}` },
  });
  if (!response.ok) throw new Error(`snapshot request failed: ${response.status}`);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()));
  return doc;
}

function stateVector(doc: Y.Doc): string {
  return Buffer.from(Y.encodeStateVector(doc)).toString("hex");
}

function canonicalMap(map: Y.Map<string>): string {
  const entries = Array.from(map.entries()).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

let harness: AuthHarness;
let sessionToken: string;
let vaultId: string;
let plugin: FakePlugin;

beforeAll(async () => {
  harness = await startAuthHarness();
  sessionToken = await harness.loginUser("chaos-owner");
  vaultId = (await harness.createVault(sessionToken, "chaos-conformance")).id;
  ({ plugin } = makeFakePlugin(harness.authUrl, {
    sessionToken,
    activeVaultId: vaultId,
  }));
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

describe("native CRDT conformance and chaos lab", () => {
  it("converges JS clients, a read-only peer, and persisted yrs state under reordered duplicates", async () => {
    DeterministicChaosSocket.reset();
    resetTokenRetryStateForTests(25);
    const documentId = `${vaultId}__${freshGuid()}`;
    const readToken = await readOnlyToken(harness.authUrl, sessionToken, vaultId, documentId);
    const writers = [
      client(plugin, documentId),
      client(plugin, documentId),
      client(plugin, documentId),
    ];
    const observer = client(plugin, documentId, readToken);
    const all = [...writers, observer];

    try {
      await waitFor(() => all.every(({ provider }) => provider.status === "connected"), {
        label: "all chaos clients connected",
        timeout: 60_000,
      });

      let random = 0xc0ffee;
      const next = () => {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        return random;
      };
      for (let index = 0; index < 180; index++) {
        if (index === 20) DeterministicChaosSocket.pause();
        const writer = writers[next() % writers.length];
        writer.map.set(`operation-${index}`, `${index}:${next().toString(16)}`);
        if (index % 13 === 0) {
          writer.awareness.setLocalStateField("cursor", { index, writer: next() % 3 });
        }
      }
      DeterministicChaosSocket.release();

      writers[2].provider.disconnect();
      await waitFor(() => writers[2].provider.status === "offline", {
        label: "one peer partitioned",
      });
      for (let index = 180; index < 220; index++) {
        writers[2].map.set(`operation-${index}`, `offline:${index}`);
        writers[index % 2].map.set(`online-${index}`, `online:${index}`);
      }
      writers[2].awareness.setLocalState(null);
      writers[2].provider.connect();

      await waitFor(() => writers.every(({ provider }) => !provider.hasLocalChanges), {
        label: "all writer versions acknowledged",
        timeout: 60_000,
      });
      await DeterministicChaosSocket.whenIdle();
      await waitFor(
        () => {
          const expected = canonicalMap(writers[0].map);
          return all.every(({ map }) => canonicalMap(map) === expected);
        },
        { label: "all peers converged", timeout: 60_000 },
      );

      const persisted = await serverSnapshot(plugin, documentId);
      const vectors = all.map(({ doc }) => stateVector(doc));
      expect(new Set(vectors)).toEqual(new Set([vectors[0]]));
      expect(stateVector(persisted)).toBe(vectors[0]);
      expect(persisted.getMap("chaos").size).toBe(260);
      persisted.destroy();
    } finally {
      for (const item of all) item.destroy();
    }
  }, 180_000);

  it("survives a hard server kill after ack and merges edits made during the outage", async () => {
    DeterministicChaosSocket.reset();
    resetTokenRetryStateForTests(25);
    const suffix = `${Date.now()}-${freshGuid()}`;
    const databasePath = path.join(os.tmpdir(), `realtime-chaos-${suffix}.db`);
    const crdtStoreDir = path.join(os.tmpdir(), `realtime-chaos-${suffix}`);
    let server: AuthServer | undefined;
    let durableClient: Client | undefined;
    let observer: Client | undefined;

    try {
      server = await startAuthServer({ databasePath, crdtStoreDir });
      const port = Number(new URL(server.url).port);
      const token = await mockLogin(server.url, "restart-owner");
      const vault = await apiCreateVault(server.url, token, "restart-chaos");
      const built = makeFakePlugin(server.url, {
        sessionToken: token,
        activeVaultId: vault.id,
      });
      const documentId = `${vault.id}__${freshGuid()}`;
      durableClient = client(built.plugin, documentId);
      await waitFor(() => durableClient?.provider.status === "connected", {
        label: "durability client connected",
      });

      durableClient.map.set("before-kill", "acknowledged");
      await waitFor(() => durableClient !== undefined && !durableClient.provider.hasLocalChanges, {
        label: "pre-kill update acknowledged",
        timeout: 60_000,
      });
      await DeterministicChaosSocket.whenIdle();
      await server.kill();
      server = undefined;

      durableClient.map.set("during-outage", "offline");
      server = await startAuthServer({ port, databasePath, crdtStoreDir });
      await waitFor(
        () =>
          durableClient?.provider.status === "connected" &&
          durableClient.map.get("during-outage") === "offline",
        { label: "client reconnected after hard kill", timeout: 60_000 },
      );
      await waitFor(() => durableClient !== undefined && !durableClient.provider.hasLocalChanges, {
        label: "offline update acknowledged after restart",
        timeout: 60_000,
      });

      observer = client(built.plugin, documentId);
      await waitFor(
        () =>
          observer?.map.get("before-kill") === "acknowledged" &&
          observer.map.get("during-outage") === "offline",
        { label: "fresh peer received durable and offline writes", timeout: 60_000 },
      );
      expect(stateVector(observer.doc)).toBe(stateVector(durableClient.doc));
    } finally {
      observer?.destroy();
      durableClient?.destroy();
      await server?.stop();
      for (const candidate of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) {
        fs.rmSync(candidate, { force: true });
      }
      fs.rmSync(crdtStoreDir, { force: true, recursive: true });
    }
  }, 180_000);
});
