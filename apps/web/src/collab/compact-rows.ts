import * as Y from 'yjs';

/** Folds stored updates into one garbage-collected update (replaying into a fresh doc drops deleted content). */
export function compactRows(rows: readonly Uint8Array[]): Uint8Array {
  const doc = new Y.Doc({ gc: true });
  try {
    doc.transact(() => rows.forEach((row) => Y.applyUpdate(doc, row)));
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
