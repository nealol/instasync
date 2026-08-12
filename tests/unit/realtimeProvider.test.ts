import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import {
  RealtimeProvider,
  SYNC_EVENT_DOCUMENT_INVALIDATED,
  SYNC_EVENT_LOCAL_CHANGES,
  type SyncSocket,
} from "../../src/sync/RealtimeProvider";
import { resetDocumentEpochStateForTests, setEpochProposalHandler } from "../../src/documentEpoch";
import type { ClientToken } from "../../src/sync/clientToken";

const TOKEN: ClientToken = {
  url: "ws://sync.test/d/vault__doc/ws",
  baseUrl: "http://sync.test/d/vault__doc",
  docId: "vault__doc",
  token: "secret",
  authorization: "full",
};

class FakeSocket implements SyncSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  closeCount = 0;

  constructor(readonly url: string) {}

  send(data: Uint8Array | ArrayBuffer): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.sent.push(bytes.slice());
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(message: Uint8Array): void {
    this.onmessage?.({ data: message });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "test drop" });
  }
}

interface ProviderFixture {
  doc: Y.Doc;
  provider: RealtimeProvider;
  sockets: FakeSocket[];
  destroy(): void;
}

function fixture(
  tokenSource: () => Promise<ClientToken> = () => Promise.resolve(TOKEN),
): ProviderFixture {
  const doc = new Y.Doc();
  const sockets: FakeSocket[] = [];
  const provider = new RealtimeProvider("vault__doc", doc, tokenSource, {
    connect: false,
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  return {
    doc,
    provider,
    sockets,
    destroy: () => {
      provider.destroy();
      doc.destroy();
    },
  };
}

function syncMessage(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

function serverStep1(doc: Y.Doc): Uint8Array {
  return syncMessage((encoder) => syncProtocol.writeSyncStep1(encoder, doc));
}

function serverStep2(doc: Y.Doc): Uint8Array {
  return syncMessage((encoder) => syncProtocol.writeSyncStep2(encoder, doc));
}

function syncAcknowledgement(version: number): Uint8Array {
  const versionEncoder = encoding.createEncoder();
  encoding.writeVarUint(versionEncoder, version);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 102);
  encoding.writeVarUint8Array(encoder, encoding.toUint8Array(versionEncoder));
  return encoding.toUint8Array(encoder);
}

function documentInvalidation(documentId: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 105);
  encoding.writeVarUint8Array(encoder, new TextEncoder().encode(JSON.stringify({ documentId })));
  return encoding.toUint8Array(encoder);
}

function messageType(message: Uint8Array): number {
  return decoding.readVarUint(decoding.createDecoder(message));
}

async function openAndHandshake(f: ProviderFixture): Promise<FakeSocket> {
  const connecting = f.provider.connect();
  await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
  const socket = f.sockets[0];
  socket.open();
  const server = new Y.Doc();
  socket.deliver(serverStep1(server));
  socket.deliver(serverStep2(server));
  await connecting;
  server.destroy();
  return socket;
}

afterEach(() => {
  setEpochProposalHandler(null);
  resetDocumentEpochStateForTests();
});

describe("RealtimeProvider", () => {
  it("waits for the server sync step before requesting a durable acknowledgement", async () => {
    const f = fixture();
    try {
      const connecting = f.provider.connect();
      await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
      const socket = f.sockets[0];
      expect(socket.url).toBe("ws://sync.test/d/vault__doc/ws/vault__doc?token=secret");
      socket.open();

      expect(socket.sent.map(messageType)).not.toContain(102);
      const server = new Y.Doc();
      socket.deliver(serverStep1(server));
      expect(socket.sent.map(messageType)).toContain(102);
      socket.deliver(serverStep2(server));
      await connecting;
      expect(f.provider.status).toBe("connected");

      socket.deliver(syncAcknowledgement(0));
      expect(f.provider.hasLocalChanges).toBe(false);
      const localChanges: boolean[] = [];
      f.provider.on(SYNC_EVENT_LOCAL_CHANGES, (pending) => localChanges.push(pending));

      f.doc.getMap("values").set("local", "change");
      expect(f.provider.hasLocalChanges).toBe(true);
      expect(localChanges).toEqual([true]);
      const sentTypes = socket.sent.map(messageType);
      expect(sentTypes.slice(-2)).toEqual([0, 102]);

      socket.deliver(syncAcknowledgement(0));
      expect(f.provider.hasLocalChanges).toBe(true);
      socket.deliver(syncAcknowledgement(1));
      expect(f.provider.hasLocalChanges).toBe(false);
      expect(localChanges).toEqual([true, false]);
      server.destroy();
    } finally {
      f.destroy();
    }
  });

  it("does not send or acknowledge local edits made through a read-only token", async () => {
    const recoveries: Uint8Array[] = [];
    const doc = new Y.Doc();
    const sockets: FakeSocket[] = [];
    const provider = new RealtimeProvider(
      "vault__doc",
      doc,
      () => Promise.resolve({ ...TOKEN, authorization: "read-only" }),
      {
        connect: false,
        onReadOnlyUpdate: (update) => recoveries.push(update),
        socketFactory: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
      },
    );
    const f: ProviderFixture = {
      doc,
      provider,
      sockets,
      destroy: () => {
        provider.destroy();
        doc.destroy();
      },
    };
    try {
      const socket = await openAndHandshake(f);
      socket.deliver(syncAcknowledgement(0));
      const before = socket.sent.length;
      const localChanges: boolean[] = [];
      f.provider.on(SYNC_EVENT_LOCAL_CHANGES, (pending) => localChanges.push(pending));

      f.doc.getMap("values").set("local", "read-only edit");

      expect(socket.sent).toHaveLength(before);
      expect(f.provider.hasLocalChanges).toBe(false);
      expect(localChanges).toEqual([]);
      expect(recoveries).toHaveLength(1);
    } finally {
      f.destroy();
    }
  });

  it("coalesces connect calls and cannot reconnect after destroy", async () => {
    const token = Promise.withResolvers<ClientToken>();
    const f = fixture(() => token.promise);
    const first = f.provider.connect();
    const second = f.provider.connect();
    expect(second).toBe(first);

    f.provider.disconnect();
    token.resolve(TOKEN);
    await first;
    expect(f.sockets).toHaveLength(0);
    expect(f.provider.status).toBe("offline");

    const reconnecting = f.provider.connect();
    await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
    const socket = f.sockets[0];
    socket.open();
    f.provider.destroy();
    await reconnecting;
    expect(socket.closeCount).toBe(1);
    expect(f.provider.status).toBe("offline");

    socket.drop();
    await Promise.resolve();
    expect(f.sockets).toHaveLength(1);
    f.doc.destroy();
  });

  it("persists and acknowledges a direct-socket epoch proposal", async () => {
    const f = fixture();
    let proposal: { documentId: string; epoch: number } | null = null;
    setEpochProposalHandler((documentId, epoch) => {
      proposal = { documentId, epoch };
    });
    try {
      const socket = await openAndHandshake(f);
      const body = new TextEncoder().encode(JSON.stringify({ epoch: 7 }));
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 103);
      encoding.writeVarUint8Array(encoder, body);
      socket.deliver(encoding.toUint8Array(encoder));

      expect(proposal).toEqual({ documentId: "vault__doc", epoch: 7 });
      const acknowledgement = socket.sent.at(-1)!;
      const decoder = decoding.createDecoder(acknowledgement);
      expect(decoding.readVarUint(decoder)).toBe(104);
      expect(JSON.parse(new TextDecoder().decode(decoding.readVarUint8Array(decoder)))).toEqual({
        epoch: 7,
      });
    } finally {
      f.destroy();
    }
  });

  it("surfaces advisory child-document invalidations", async () => {
    const f = fixture();
    const invalidated: string[] = [];
    f.provider.on(SYNC_EVENT_DOCUMENT_INVALIDATED, (documentId) => invalidated.push(documentId));
    try {
      const socket = await openAndHandshake(f);
      socket.deliver(documentInvalidation("vault__remote-guid"));
      expect(invalidated).toEqual(["vault__remote-guid"]);
      expect(f.provider.status).toBe("connected");
    } finally {
      f.destroy();
    }
  });
});
