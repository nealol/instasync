import type * as Y from "yjs";

/**
 * Applies `newText` to a Y.Text by replacing only the region that actually
 * changed. We trim the common prefix and suffix and rewrite the middle in a
 * single delete+insert. This keeps deltas small and avoids clobbering the whole
 * document (which would disrupt other editors' relative cursor positions).
 *
 * Must be called inside a `ydoc.transact(..., origin)` — the caller owns the
 * transaction so the origin is consistent and operation ordering is predictable.
 */
export function applyTextToYText(ytext: Y.Text, newText: string): void {
  const oldText = ytext.toString();
  if (oldText === newText) return;

  const oldLen = oldText.length;
  const newLen = newText.length;

  // Common prefix length.
  let start = 0;
  const maxStart = Math.min(oldLen, newLen);
  while (start < maxStart && oldText[start] === newText[start]) {
    start++;
  }

  // Common suffix length (not overlapping the prefix).
  let endOld = oldLen;
  let endNew = newLen;
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
    endOld--;
    endNew--;
  }

  const deleteCount = endOld - start;
  const insert = newText.slice(start, endNew);

  if (deleteCount > 0) ytext.delete(start, deleteCount);
  if (insert.length > 0) ytext.insert(start, insert);
}
