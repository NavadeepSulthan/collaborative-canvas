import { withSpan } from '../observability/tracing.js';
import type { Unsubscribe } from './ports.js';
import { Room, type RoomDeps } from './room.js';

export interface RoomRegistryDeps extends RoomDeps {
  idleTtlMs: number;
  /** How often each loaded room gossips its state vector. 0 disables anti-entropy. */
  antiEntropyIntervalMs: number;
}

interface Entry {
  room: Room;
  ready: Promise<Room>;
  refs: number;
  unsubscribe: Unsubscribe | null;
  evictTimer: NodeJS.Timeout | null;
}

/**
 * Owns the lifecycle of rooms on this node: lazy load on first join, reference counting,
 * and idle eviction (flush -> compact -> unsubscribe -> destroy).
 */
export class RoomRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly antiEntropy: NodeJS.Timeout | null;

  constructor(private readonly deps: RoomRegistryDeps) {
    this.antiEntropy =
      deps.antiEntropyIntervalMs > 0
        ? setInterval(() => this.gossip(), deps.antiEntropyIntervalMs).unref()
        : null;
  }

  get size(): number {
    return this.entries.size;
  }

  async acquire(key: string): Promise<Room> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.open(key);
      this.entries.set(key, entry);
    }
    entry.refs += 1;
    if (entry.evictTimer) {
      clearTimeout(entry.evictTimer);
      entry.evictTimer = null;
    }
    try {
      return await entry.ready;
    } catch (error) {
      entry.refs -= 1;
      throw error;
    }
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) this.scheduleEviction(key, entry);
  }

  /** Flushes and closes every room. Used during graceful shutdown. */
  async shutdown(): Promise<void> {
    if (this.antiEntropy) clearInterval(this.antiEntropy);
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(
      entries.map(async (entry) => {
        if (entry.evictTimer) clearTimeout(entry.evictTimer);
        await entry.room.flush();
        if (entry.room.hasUnpersistedChanges) {
          this.deps.logger.error(
            { room: entry.room.key },
            'shutting down with unpersisted changes',
          );
        }
        await entry.unsubscribe?.();
        entry.room.destroy();
      }),
    );
  }

  private open(key: string): Entry {
    const room = new Room(key, this.deps);
    const entry: Entry = { room, refs: 0, unsubscribe: null, evictTimer: null, ready: undefined! };
    entry.ready = withSpan('room.open', { room: key }, async () => {
      // Subscribe before loading: anything published during the load is applied too
      // (CRDT updates are idempotent, so overlap with the snapshot is harmless).
      entry.unsubscribe = await this.deps.backplane.subscribe(key, (m) => room.applyRemote(m));
      room.hydrate(await this.deps.store.load(key));
      // Edits already published but not yet persisted by other nodes would otherwise be missed
      // until the next anti-entropy round; ask for them now.
      room.announceStateVector();
      this.deps.metrics.roomOpened();
      return room;
    }).catch(async (error: unknown) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      await entry.unsubscribe?.();
      room.destroy();
      throw error;
    });
    return entry;
  }

  private gossip(): void {
    for (const entry of this.entries.values()) {
      void entry.ready.then((room) => room.announceStateVector()).catch(() => undefined);
    }
  }

  private scheduleEviction(key: string, entry: Entry): void {
    entry.evictTimer = setTimeout(() => void this.evict(key, entry), this.deps.idleTtlMs);
    entry.evictTimer.unref();
  }

  private async evict(key: string, entry: Entry): Promise<void> {
    entry.evictTimer = null;
    if (entry.refs > 0 || this.entries.get(key) !== entry) return;

    await entry.room.flush();
    if (entry.room.hasUnpersistedChanges) {
      // Storage is down: keep the room (and its edits) in memory and try again later.
      this.deps.logger.warn({ room: key }, 'eviction postponed: unpersisted changes');
      this.scheduleEviction(key, entry);
      return;
    }
    await entry.room.compact();
    if (entry.refs > 0) return;

    this.entries.delete(key);
    await entry.unsubscribe?.();
    entry.room.destroy();
    this.deps.metrics.roomClosed();
  }
}
