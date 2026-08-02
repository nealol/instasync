import picomatch from "picomatch";
import type { FileKind, RtmdConfig, SyncFileState } from "./config";

export function shouldSyncFile(config: RtmdConfig, path: string, kind: FileKind): boolean {
  if (kind !== "attachment") return true;
  if (config.attachmentSync?.enabled === false) return false;
  const globs = config.attachmentSync?.includeGlobs ?? [];
  return globs.length === 0 || globs.some((glob) => picomatch.isMatch(path, glob, { dot: true }));
}

export function filteredSnapshot(
  config: RtmdConfig,
  snapshot: Record<string, SyncFileState>,
): Record<string, SyncFileState> {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([path, state]) => shouldSyncFile(config, path, state.kind)),
  );
}

export function forgetIgnoredAttachments(
  config: RtmdConfig,
  snapshot: Record<string, SyncFileState>,
): void {
  for (const [path, state] of Object.entries(snapshot)) {
    if (!shouldSyncFile(config, path, state.kind)) delete snapshot[path];
  }
}

export function parseAttachmentGlobs(value: string): string[] {
  return value
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean);
}
