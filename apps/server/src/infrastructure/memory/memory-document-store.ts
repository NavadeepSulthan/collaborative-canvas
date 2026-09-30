import type { CompactionResult, DocumentStore } from '../../collab/ports.js';

interface RoomLog {
  snapshot: Uint8Array | null;
  updates: Uint8Array[];
}

/** Non-durable store for local development and tests. Same semantics as the Postgres store. */
export class MemoryDocumentStore implements DocumentStore {
  private readonly rooms = new Map<string, RoomLog>();
  private readonly locks = new Set<string>();

  async load(roomKey: string): Promise<Uint8Array[]> {
    const log = this.rooms.get(roomKey);
    if (!log) return [];
    return log.snapshot ? [log.snapshot, ...log.updates] : [...log.updates];
  }

  async append(roomKey: string, update: Uint8Array): Promise<void> {
    this.logFor(roomKey).updates.push(update);
  }

  async compact(
    roomKey: string,
    merge: (updates: Uint8Array[]) => Uint8Array,
  ): Promise<CompactionResult | null> {
    if (this.locks.has(roomKey)) return null;
    this.locks.add(roomKey);
    try {
      const log = this.logFor(roomKey);
      const taken = log.updates.length;
      if (taken === 0) return { mergedUpdates: 0, snapshotBytes: log.snapshot?.byteLength ?? 0 };
      const inputs = log.snapshot ? [log.snapshot, ...log.updates] : [...log.updates];
      log.snapshot = merge(inputs);
      log.updates.splice(0, taken);
      return { mergedUpdates: taken, snapshotBytes: log.snapshot.byteLength };
    } finally {
      this.locks.delete(roomKey);
    }
  }

  /** Test helper: number of un-compacted rows for a room. */
  pendingUpdates(roomKey: string): number {
    return this.rooms.get(roomKey)?.updates.length ?? 0;
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}

  private logFor(roomKey: string): RoomLog {
    let log = this.rooms.get(roomKey);
    if (!log) {
      log = { snapshot: null, updates: [] };
      this.rooms.set(roomKey, log);
    }
    return log;
  }
}
