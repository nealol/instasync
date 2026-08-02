/**
 * `.rtmd` — the per-folder vault binding. One JSON file at the synced folder's
 * root holding the server URL, vault id, credentials, and the last-synced
 * snapshot. Located like a git root: walk up from the working directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const RTMD_FILE = ".rtmd";

export type FileKind = "note" | "canvas" | "base" | "attachment";

export interface OAuthStoredTokens {
  accessToken: string;
  tokenType: string;
  refreshToken: string;
  scope: string;
  /** Epoch ms; recomputed into `expiresIn` when reconstructing the provider. */
  expiresAt: number;
}

export type AuthConfig =
  | { mode: "user"; token: string }
  | { mode: "cursor"; token: string; cursorId?: string; cursorName?: string }
  | { mode: "cursor-oauth"; clientId: string; tokens: OAuthStoredTokens; cursorName?: string };

export interface SyncFileState {
  kind: FileKind;
  /** sha256 hex of the last-synced (normalized) content. */
  hash: string;
  size: number;
  /** Local mtime at last sync; size+mtime fast path skips re-hashing. */
  mtimeMs: number;
  /** Notes only. */
  guid?: string;
}

export interface SyncState {
  lastSyncedAt: string;
  files: Record<string, SyncFileState>;
}

export interface AttachmentSyncSettings {
  /** False means sync commands ignore every attachment locally and remotely. */
  enabled: boolean;
  /** Empty means every attachment; otherwise only matching vault-relative paths sync. */
  includeGlobs: string[];
}

export interface RtmdConfig {
  version: 1;
  baseUrl: string;
  vaultId: string;
  vaultName?: string;
  auth?: AuthConfig;
  attachmentSync?: AttachmentSyncSettings;
  sync?: SyncState;
}

export class CliError extends Error {}

export const NO_RTMD_HELP = `not inside an rtmd vault folder (no ${RTMD_FILE} found in this or any parent directory).

Each synced folder is tied to one vault by a ${RTMD_FILE} file at its root,
which also stores your login. Create one with:

  rtmd login [dir]            log in and pick an existing vault for a folder
  rtmd clone <vault> [dir]    log in and download a vault into a folder
  rtmd init [dir]             log in and create a new vault from a folder`;

export function readRtmd(dir: string): RtmdConfig {
  const file = path.join(dir, RTMD_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new CliError(`cannot read ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`${file} is not valid JSON`);
  }
  const cfg = parsed as RtmdConfig;
  if (cfg.version !== 1 || typeof cfg.baseUrl !== "string" || typeof cfg.vaultId !== "string") {
    throw new CliError(`${file} is missing required fields (version, baseUrl, vaultId)`);
  }
  if (
    cfg.attachmentSync !== undefined &&
    (cfg.attachmentSync === null ||
      typeof cfg.attachmentSync !== "object" ||
      typeof cfg.attachmentSync.enabled !== "boolean" ||
      !Array.isArray(cfg.attachmentSync.includeGlobs) ||
      !cfg.attachmentSync.includeGlobs.every((glob) => typeof glob === "string"))
  ) {
    throw new CliError(`${file} has invalid attachmentSync settings`);
  }
  return cfg;
}

/** Atomic write: temp file + rename, so an interrupted sync never corrupts it. */
export function writeRtmd(dir: string, config: RtmdConfig): void {
  const file = path.join(dir, RTMD_FILE);
  const tmp = path.join(dir, `${RTMD_FILE}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Walk up from `startDir` to the filesystem root looking for `.rtmd`. */
export function findRtmdDir(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, RTMD_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface Workspace {
  dir: string;
  config: RtmdConfig;
}

export function requireWorkspace(startDir: string): Workspace {
  const dir = findRtmdDir(startDir);
  if (!dir) throw new CliError(NO_RTMD_HELP);
  return { dir, config: readRtmd(dir) };
}
