import type * as Y from 'yjs';

export interface TextEdit {
  index: number;
  deleteCount: number;
  insert: string;
}

/**
 * Minimal single-range edit turning `prev` into `next` (common prefix/suffix trim).
 * Applying edits instead of replacing the whole string lets two people type in the
 * same note concurrently without clobbering each other.
 */
export function diffText(prev: string, next: string): TextEdit | null {
  if (prev === next) return null;
  let start = 0;
  const minLength = Math.min(prev.length, next.length);
  while (start < minLength && prev[start] === next[start]) start++;
  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
    prevEnd--;
    nextEnd--;
  }
  return { index: start, deleteCount: prevEnd - start, insert: next.slice(start, nextEnd) };
}

export function applyTextDiff(text: Y.Text, next: string): void {
  const edit = diffText(text.toString(), next);
  if (!edit) return;
  if (edit.deleteCount > 0) text.delete(edit.index, edit.deleteCount);
  if (edit.insert) text.insert(edit.index, edit.insert);
}
