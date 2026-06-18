import { useEffect, useState } from "react";
import type RealtimePlugin from "../main";
import type { FileAtCommit } from "./types";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Fetch a binary at a commit and render it as an object URL image. */
function useBlobUrl(
  plugin: RealtimePlugin,
  vaultId: string,
  hash: string | null,
  path: string,
): { url: string | null; error: string | null } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hash || !isImagePath(path)) return;
    let revoked: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const bytes = await plugin.auth.getHistoryBlob(vaultId, hash, path);
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(new Blob([bytes]));
        revoked = objectUrl;
        setUrl(objectUrl);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [plugin, vaultId, hash, path]);

  return { url, error };
}

function BinaryPane({
  plugin,
  vaultId,
  commitHash,
  path,
  file,
  label,
}: {
  plugin: RealtimePlugin;
  vaultId: string;
  commitHash: string | null;
  path: string;
  file: FileAtCommit;
  label: string;
}) {
  const binary = file.type === "binary" ? file : null;
  const { url, error } = useBlobUrl(
    plugin,
    vaultId,
    binary && binary.blobAvailable !== false && commitHash ? commitHash : null,
    path,
  );

  return (
    <div className="realtime-history-binary-pane">
      <div className="realtime-history-binary-label">{label}</div>
      {file.type === "absent" && <p className="setting-item-description">(absent)</p>}
      {binary && url && <img src={url} alt={path} />}
      {binary && !url && (
        <div className="realtime-history-binary-meta">
          <div>{path.split("/").pop()}</div>
          <div>{formatSize(binary.size)}</div>
          <div className="realtime-history-hash">{binary.hash.slice(0, 12)}…</div>
          {(error || binary.blobAvailable === false) && (
            <div className="realtime-history-error">blob no longer available</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Side-by-side before/after preview for a binary path at a commit. */
export function BinaryPreview({
  plugin,
  vaultId,
  commitHash,
  parentHash,
  path,
  before,
  after,
}: {
  plugin: RealtimePlugin;
  vaultId: string;
  commitHash: string;
  parentHash: string | null;
  path: string;
  before: FileAtCommit;
  after: FileAtCommit;
}) {
  const beforeHash = before.type === "binary" ? before.hash : null;
  const afterHash = after.type === "binary" ? after.hash : null;
  const changed = beforeHash !== afterHash;

  return (
    <div className="realtime-history-binary">
      {changed && before.type !== "absent" && (
        <BinaryPane
          plugin={plugin}
          vaultId={vaultId}
          commitHash={parentHash}
          path={path}
          file={before}
          label="Before"
        />
      )}
      <BinaryPane
        plugin={plugin}
        vaultId={vaultId}
        commitHash={commitHash}
        path={path}
        file={after}
        label={changed ? "After" : "Unchanged"}
      />
    </div>
  );
}
