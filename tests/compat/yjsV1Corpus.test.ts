import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";

type Corpus = {
  schemaVersion: number;
  producer: {
    pluginVersion: string;
    commit: string;
    yjsVersion: string;
    yProtocolsVersion: string;
    wireFormat: string;
  };
  document: {
    updateV1Base64: string;
    syncUpdateMessageBase64: string;
    syncStep1MessageBase64: string;
    expected: { contents: string; metadata: Record<string, unknown> };
  };
};

const corpus = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../compat/corpus/yjs-v1.json"), "utf8"),
) as Corpus;

function decoded(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

function expectDocument(doc: Y.Doc): void {
  expect(doc.getText("contents").toString()).toBe(corpus.document.expected.contents);
  expect(doc.getMap("metadata").toJSON()).toEqual(corpus.document.expected.metadata);
}

describe("released Yjs v1 protocol corpus", () => {
  it("replays the released full-state update", () => {
    expect(corpus.schemaVersion).toBe(1);
    expect(corpus.producer).toMatchObject({
      pluginVersion: "0.4.3-alpha.7",
      wireFormat: "yjs-v1",
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decoded(corpus.document.updateV1Base64));
    expectDocument(doc);
  });

  it("accepts the released sync update message", () => {
    const doc = new Y.Doc();
    const decoder = decoding.createDecoder(decoded(corpus.document.syncUpdateMessageBase64));
    expect(decoding.readVarUint(decoder)).toBe(0);
    const reply = encoding.createEncoder();
    expect(syncProtocol.readSyncMessage(decoder, reply, doc, "released-client")).toBe(2);
    expectDocument(doc);
  });

  it("answers the released state-vector handshake without mutating local state", () => {
    const doc = new Y.Doc();
    const decoder = decoding.createDecoder(decoded(corpus.document.syncStep1MessageBase64));
    expect(decoding.readVarUint(decoder)).toBe(0);
    const reply = encoding.createEncoder();
    expect(syncProtocol.readSyncMessage(decoder, reply, doc, "released-client")).toBe(0);
    expect(encoding.length(reply)).toBeGreaterThan(0);
    expect(doc.getText("contents").toString()).toBe("");
  });
});
