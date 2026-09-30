import * as Y from 'yjs';

/**
 * Folds a snapshot plus any number of deltas into a single garbage-collected state update.
 * Replaying into a fresh doc (instead of Y.mergeUpdates) lets Yjs GC deleted content,
 * so snapshots don't grow forever with tombstoned data.
 */
export function compactUpdates(updates: Uint8Array[]): Uint8Array {
  const doc = new Y.Doc({ gc: true });
  try {
    doc.transact(() => {
      for (const update of updates) Y.applyUpdate(doc, update);
    });
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
