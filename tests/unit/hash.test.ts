import { describe, it, expect } from "vitest";
import { sha256Hex } from "../../src/hash";

const enc = (s: string) => new TextEncoder().encode(s).buffer;

describe("sha256Hex", () => {
	it("hashes the empty buffer to the known SHA-256 digest", async () => {
		expect(await sha256Hex(new ArrayBuffer(0))).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	it("hashes 'abc' to the known digest", async () => {
		expect(await sha256Hex(enc("abc"))).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("is deterministic and content-addressed", async () => {
		const a = await sha256Hex(enc("same bytes"));
		const b = await sha256Hex(enc("same bytes"));
		const c = await sha256Hex(enc("other bytes"));
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});
});
