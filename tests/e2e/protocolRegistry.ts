import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const OBSIDIAN_PROTOCOL_KEY = "HKCU\\Software\\Classes\\obsidian";

export type ProtocolRegistrySnapshot = {
  backupPath: string;
  existed: boolean;
};

function runReg(args: string[]) {
  return spawnSync("reg.exe", args, { encoding: "utf8" });
}

function throwIfFailed(result: ReturnType<typeof runReg>, action: string) {
  if (result.status === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new Error(`${action} failed${detail ? `: ${detail}` : ""}`);
}

export function snapshotObsidianProtocolRegistry(): ProtocolRegistrySnapshot | undefined {
  if (process.platform !== "win32") return undefined;

  const backupPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "realtime-obsidian-protocol-")),
    "obsidian-protocol.reg",
  );
  const result = runReg(["export", OBSIDIAN_PROTOCOL_KEY, backupPath, "/y"]);

  if (result.status === 0) return { backupPath, existed: true };
  if (result.stderr.includes("unable to find") || result.stdout.includes("unable to find")) {
    return { backupPath, existed: false };
  }

  throwIfFailed(result, "Exporting Obsidian protocol registry key");
  return undefined;
}

export function restoreObsidianProtocolRegistry(snapshot: ProtocolRegistrySnapshot | undefined) {
  if (process.platform !== "win32" || !snapshot) return;

  const deleteResult = runReg(["delete", OBSIDIAN_PROTOCOL_KEY, "/f"]);
  if (
    deleteResult.status !== 0 &&
    !deleteResult.stderr.includes("unable to find") &&
    !deleteResult.stdout.includes("unable to find")
  ) {
    throwIfFailed(deleteResult, "Deleting Obsidian protocol registry key");
  }

  if (snapshot.existed) {
    throwIfFailed(runReg(["import", snapshot.backupPath]), "Restoring Obsidian protocol registry key");
  }
}
