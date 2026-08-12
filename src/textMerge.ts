import { diffArrays, type ArrayChange } from "diff";

interface TextEdit {
  start: number;
  end: number;
  replacement: string[];
}

export type TextMergeResult = { kind: "merged"; content: string } | { kind: "conflict" };

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function edits(base: string[], next: string[]): TextEdit[] {
  const result: TextEdit[] = [];
  let baseOffset = 0;
  let pending: TextEdit | null = null;
  const flush = () => {
    if (!pending) return;
    result.push(pending);
    pending = null;
  };

  for (const change of diffArrays(base, next) as ArrayChange<string>[]) {
    if (!change.added && !change.removed) {
      flush();
      baseOffset += change.value.length;
      continue;
    }
    pending ??= { start: baseOffset, end: baseOffset, replacement: [] };
    if (change.removed) {
      baseOffset += change.value.length;
      pending.end = baseOffset;
    } else {
      pending.replacement.push(...change.value);
    }
  }
  flush();
  return result;
}

function sameEdit(left: TextEdit, right: TextEdit): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.replacement.length === right.replacement.length &&
    left.replacement.every((line, index) => line === right.replacement[index])
  );
}

function overlaps(left: TextEdit, right: TextEdit): boolean {
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;
  if (leftInsertion && rightInsertion) return left.start === right.start;
  if (leftInsertion) return left.start >= right.start && left.start <= right.end;
  if (rightInsertion) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

/**
 * Conservative line-oriented diff3. Disjoint changes and byte-identical edits
 * merge automatically. Any overlapping edit is returned for explicit recovery
 * rather than guessing and dropping one side.
 */
export function mergeText(
  baseText: string,
  localText: string,
  remoteText: string,
): TextMergeResult {
  if (localText === remoteText) return { kind: "merged", content: localText };
  if (localText === baseText) return { kind: "merged", content: remoteText };
  if (remoteText === baseText) return { kind: "merged", content: localText };

  const base = lines(baseText);
  const local = edits(base, lines(localText));
  const remote = edits(base, lines(remoteText));
  const duplicateRemote = new Set<number>();

  for (const localEdit of local) {
    for (let index = 0; index < remote.length; index++) {
      const remoteEdit = remote[index];
      if (sameEdit(localEdit, remoteEdit)) {
        duplicateRemote.add(index);
      } else if (overlaps(localEdit, remoteEdit)) {
        return { kind: "conflict" };
      }
    }
  }

  const combined = [...local, ...remote.filter((_edit, index) => !duplicateRemote.has(index))].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const output: string[] = [];
  let offset = 0;
  for (const edit of combined) {
    output.push(...base.slice(offset, edit.start), ...edit.replacement);
    offset = edit.end;
  }
  output.push(...base.slice(offset));
  return { kind: "merged", content: output.join("") };
}
