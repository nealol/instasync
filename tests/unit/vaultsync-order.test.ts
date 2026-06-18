import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src/VaultSync.ts"), "utf8");

describe("VaultSync publish ordering", () => {
  it("waits for structured creator docs before publishing them to the index", () => {
    const occurrences = [
      ...source.matchAll(/ensureStructuredDocument\([^\n]+true\);[\s\S]*?this\.structured\.set/g),
    ];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    for (const occurrence of occurrences) {
      expect(occurrence[0]).toContain("await doc.whenReady();");
    }
  });
});
