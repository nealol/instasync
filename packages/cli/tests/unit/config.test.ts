import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CliError,
  findRtmdDir,
  readRtmd,
  requireWorkspace,
  writeRtmd,
  type RtmdConfig,
} from "../../src/config";

const config: RtmdConfig = {
  version: 1,
  baseUrl: "https://example.com",
  vaultId: "v1",
  vaultName: "Notes",
  auth: { mode: "user", token: "tok" },
};

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtmd-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe(".rtmd round-trip", () => {
  it("writes and reads back", () => {
    writeRtmd(dir, config);
    expect(readRtmd(dir)).toEqual(config);
  });

  it("rejects invalid JSON", () => {
    fs.writeFileSync(path.join(dir, ".rtmd"), "{nope");
    expect(() => readRtmd(dir)).toThrow(CliError);
  });

  it("rejects missing required fields", () => {
    fs.writeFileSync(path.join(dir, ".rtmd"), JSON.stringify({ version: 1 }));
    expect(() => readRtmd(dir)).toThrow(/required fields/);
  });
});

describe("findRtmdDir / requireWorkspace", () => {
  it("walks up to the folder root", () => {
    writeRtmd(dir, config);
    const nested = path.join(dir, "a/b/c");
    fs.mkdirSync(nested, { recursive: true });
    expect(findRtmdDir(nested)).toBe(dir);
    expect(requireWorkspace(nested).config.vaultId).toBe("v1");
  });

  it("explains login/clone/init when nothing is found", () => {
    expect(() => requireWorkspace(dir)).toThrow(/rtmd login/);
  });
});
