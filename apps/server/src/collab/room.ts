import { CloseCode, MessageType } from '@canvas/shared';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type { Logger } from '../observability/logger.js';
import { withSpan } from '../observability/tracing.js';
import { compactUpdates } from './compaction.js';
import { Throttle } from './throttle.js';
import {
  BackplaneKind,
  type Backplane,
  type BackplaneMessage,
  type CollabMetrics,
  type DocumentStore,
  type Peer,
} from './ports.js';
import { WriteBehindBuffer } from './write-behind-buffer.js';

const STORE_ORIGIN = Symbol('store');
const BACKPLANE_ORIGIN = Symbol('backplane');
/** Origin for a batch of client updates from more than one peer. */
const CLIENTS_ORIGIN = Symbol('clients');
/** An update with no structs and an empty delete set encodes to two zero bytes. */
const EMPTY_UPDATE_BYTES = 2;

export class ProtocolError extends Error {}

export interface RoomDeps {
  nodeId: string;
  backplane: Backplane;
  store: DocumentStore;
  metrics: CollabMetrics;
  logger: Logger;
  persistDebounceMs: number;
  compactionThreshold: number;
  /** Max fan-out rate per room. An idle room flushes on the next tick; a busy one at most this often. */
  broadcastIntervalMs: number;
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

/**
 * One collaborative document on this node (actor-style: all state for a room lives here).
 *
 * Invariant: an edit is persisted and published to the backplane exactly once — by the node
 * whose client produced it. Updates that arrive from storage or other nodes are only applied
 * and relayed to local peers.
 */
export class Room {
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  /** Peer -> awareness client ids it controls, so we can clear its cursor when it leaves. */
  private readonly peers = new Map<Peer, Set<number>>();
  private readonly writeBuffer: WriteBehindBuffer;
  private readonly fanOut: Throttle;
  private readonly log: Logger;
  private incoming: { peer: Peer; update: Uint8Array }[] = [];
  private pendingUpdates: { update: Uint8Array; origin: unknown }[] = [];
  private pendingPublish: Uint8Array[] = [];
  private readonly pendingAwareness = new Set<number>();
  private readonly pendingAwarenessPublish = new Set<number>();
  private flushesSinceCompaction = 0;
  private compacting: Promise<void> | null = null;

  constructor(
    readonly key: string,
    private readonly deps: RoomDeps,
  ) {
    this.log = deps.logger.child({ room: key });
    this.awareness.setLocalState(null);
    this.writeBuffer = new WriteBehindBuffer({
      debounceMs: deps.persistDebounceMs,
      write: (update) =>
        withSpan('room.persist', { room: key, bytes: update.byteLength }, () =>
          deps.store.append(key, update),
        ),
      onWritten: (seconds) => {
        deps.metrics.persisted('ok', seconds);
        this.flushesSinceCompaction += 1;
        if (this.flushesSinceCompaction >= deps.compactionThreshold) void this.compact();
      },
      onError: (error, seconds) => {
        deps.metrics.persisted('error', seconds);
        this.log.error({ err: error }, 'failed to persist update; will retry');
      },
    });
    this.fanOut = new Throttle(deps.broadcastIntervalMs, () => this.flushFanOut());
    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
  }

  get peerCount(): number {
    return this.peers.size;
  }

  get hasUnpersistedChanges(): boolean {
    return this.writeBuffer.hasPending;
  }

  /** Applies persisted state without re-persisting or re-publishing it. */
  hydrate(updates: Uint8Array[]): void {
    this.doc.transact(() => {
      for (const update of updates) Y.applyUpdate(this.doc, update, STORE_ORIGIN);
    }, STORE_ORIGIN);
  }

  join(peer: Peer): void {
    this.peers.set(peer, new Set());
    this.deps.metrics.peerJoined();

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Sync);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    peer.send(encoding.toUint8Array(encoder));

    const clients = [...this.awareness.getStates().keys()];
    if (clients.length > 0) {
      peer.send(awarenessFrame(awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients)));
    }
  }

  leave(peer: Peer): void {
    const controlled = this.peers.get(peer);
    if (!controlled) return;
    // Keep edits that arrived just before the disconnect.
    this.applyIncoming();
    this.peers.delete(peer);
    this.deps.metrics.peerLeft();
    awarenessProtocol.removeAwarenessStates(this.awareness, [...controlled], null);
  }

  /** Handles one binary frame from a client. Throws ProtocolError on malformed input. */
  handleMessage(peer: Peer, data: Uint8Array): void {
    try {
      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);
      switch (type) {
        case MessageType.Sync:
          this.deps.metrics.messageReceived('sync');
          this.handleSync(peer, decoder);
          break;
        case MessageType.Awareness:
          this.deps.metrics.messageReceived('awareness');
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            decoding.readVarUint8Array(decoder),
            peer,
          );
          break;
        case MessageType.QueryAwareness:
          this.deps.metrics.messageReceived('query_awareness');
          peer.send(
            awarenessFrame(
              awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
                ...this.awareness.getStates().keys(),
              ]),
            ),
          );
          break;
        default:
          throw new ProtocolError(`unsupported message type ${type}`);
      }
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(`malformed message: ${(error as Error).message}`);
    }
  }

  /** Applies a message published by another node. */
  applyRemote(message: BackplaneMessage): void {
    if (message.origin === this.deps.nodeId) return;
    this.deps.metrics.backplane('in');
    switch (message.kind) {
      case BackplaneKind.DocUpdate:
        Y.applyUpdate(this.doc, message.payload, BACKPLANE_ORIGIN);
        break;
      case BackplaneKind.Awareness:
        awarenessProtocol.applyAwarenessUpdate(this.awareness, message.payload, BACKPLANE_ORIGIN);
        break;
      case BackplaneKind.StateVector: {
        // Reply with whatever the announcing node is missing (e.g. a dropped Pub/Sub message).
        const diff = Y.encodeStateAsUpdate(this.doc, message.payload);
        if (diff.byteLength > EMPTY_UPDATE_BYTES) this.publish(BackplaneKind.DocUpdate, diff);
        break;
      }
    }
  }

  /** Anti-entropy: advertise what this node has so peers can send anything it missed. */
  announceStateVector(): void {
    this.publish(BackplaneKind.StateVector, Y.encodeStateVector(this.doc));
  }

  flush(): Promise<void> {
    this.fanOut.flush();
    return this.writeBuffer.flush();
  }

  /** Folds the delta log into a snapshot. Concurrent calls (and other nodes) are coalesced. */
  compact(): Promise<void> {
    this.compacting ??= (async () => {
      try {
        const result = await withSpan('room.compact', { room: this.key }, () =>
          this.deps.store.compact(this.key, compactUpdates),
        );
        if (result) {
          this.flushesSinceCompaction = 0;
          this.deps.metrics.compacted('ok');
          this.log.debug(result, 'compacted document');
        } else {
          this.deps.metrics.compacted('skipped');
        }
      } catch (error) {
        this.deps.metrics.compacted('error');
        this.log.error({ err: error }, 'compaction failed');
      } finally {
        this.compacting = null;
      }
    })();
    return this.compacting;
  }

  destroy(): void {
    this.fanOut.cancel();
    this.writeBuffer.dispose();
    this.awareness.destroy();
    this.doc.destroy();
  }

  private handleSync(peer: Peer, decoder: decoding.Decoder): void {
    const syncType = decoding.readVarUint(decoder);
    switch (syncType) {
      case syncProtocol.messageYjsSyncStep1: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MessageType.Sync);
        syncProtocol.readSyncStep1(decoder, encoder, this.doc);
        peer.send(encoding.toUint8Array(encoder));
        break;
      }
      case syncProtocol.messageYjsSyncStep2:
      case syncProtocol.messageYjsUpdate: {
        const update = decoding.readVarUint8Array(decoder);
        // Viewers may read but their writes are dropped.
        if (peer.user.role === 'viewer') return;
        this.incoming.push({ peer, update });
        this.fanOut.request();
        break;
      }
      default:
        throw new ProtocolError(`unsupported sync message ${syncType}`);
    }
  }

  /**
   * Integrates every queued client update in one transaction. Yjs then emits a single combined
   * update, so per-edit transaction overhead and later merge work disappear under load.
   */
  private applyIncoming(): void {
    if (this.incoming.length === 0) return;
    const batch = this.incoming;
    this.incoming = [];
    const first = batch[0]!.peer;
    const origin = batch.every((b) => b.peer === first) ? first : CLIENTS_ORIGIN;
    const rejected = new Set<Peer>();
    this.doc.transact(() => {
      for (const { peer, update } of batch) {
        if (rejected.has(peer)) continue;
        try {
          Y.applyUpdate(this.doc, update);
        } catch (error) {
          rejected.add(peer);
          this.log.warn({ err: error, peer_id: peer.id }, 'rejected malformed update');
        }
      }
    }, origin);
    rejected.forEach((peer) => peer.close(CloseCode.BadRequest, 'protocol error'));
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === STORE_ORIGIN) return;
    this.pendingUpdates.push({ update, origin });
    if (origin !== BACKPLANE_ORIGIN) {
      this.writeBuffer.push(update);
      this.pendingPublish.push(update);
    }
    this.fanOut.request();
  };

  private readonly onAwarenessUpdate = (change: AwarenessChange, origin: unknown): void => {
    const controlled = this.peers.get(origin as Peer);
    if (controlled) {
      change.added.forEach((id) => controlled.add(id));
      change.removed.forEach((id) => controlled.delete(id));
    }
    // Every node expires stale states itself, so timeouts are never fanned out.
    const publish = origin !== BACKPLANE_ORIGIN && origin !== 'timeout';
    for (const id of [...change.added, ...change.updated, ...change.removed]) {
      this.pendingAwareness.add(id);
      if (publish) this.pendingAwarenessPublish.add(id);
    }
    this.fanOut.request();
  };

  /**
   * Sends everything that changed since the last flush as one frame per kind. Under load this
   * turns N edits x M peers socket writes into (flushes/s) x M, and cursor moves collapse to
   * each user's latest position.
   */
  private flushFanOut(): void {
    this.applyIncoming();
    if (this.pendingUpdates.length > 0) {
      const batch = this.pendingUpdates;
      this.pendingUpdates = [];
      const merged =
        batch.length === 1 ? batch[0]!.update : Y.mergeUpdates(batch.map((b) => b.update));
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MessageType.Sync);
      syncProtocol.writeUpdate(encoder, merged);
      // Echoing a client's own edits is harmless (CRDT idempotent); only skip when there's one author.
      const soleOrigin = batch.every((b) => b.origin === batch[0]!.origin)
        ? batch[0]!.origin
        : null;
      this.broadcast(encoding.toUint8Array(encoder), soleOrigin);
    }

    if (this.pendingPublish.length > 0) {
      const local = this.pendingPublish;
      this.pendingPublish = [];
      this.publish(BackplaneKind.DocUpdate, local.length === 1 ? local[0]! : Y.mergeUpdates(local));
    }

    if (this.pendingAwareness.size > 0) {
      const payload = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
        ...this.pendingAwareness,
      ]);
      this.pendingAwareness.clear();
      // Echo to the sender as well: y-websocket clients treat 30s without any incoming
      // message as a dead connection, and awareness renewals (every 15s) are the keep-alive.
      this.broadcast(awarenessFrame(payload), null);
    }

    if (this.pendingAwarenessPublish.size > 0) {
      const ids = [...this.pendingAwarenessPublish];
      this.pendingAwarenessPublish.clear();
      this.publish(
        BackplaneKind.Awareness,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids),
      );
    }
  }

  private broadcast(message: Uint8Array, except: unknown): void {
    for (const peer of this.peers.keys()) {
      if (peer !== except) peer.send(message);
    }
  }

  private publish(kind: BackplaneKind, payload: Uint8Array): void {
    this.deps.metrics.backplane('out');
    this.deps.backplane
      .publish(this.key, { origin: this.deps.nodeId, kind, payload })
      .catch((error: unknown) => this.log.error({ err: error }, 'backplane publish failed'));
  }
}

function awarenessFrame(payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Awareness);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}
