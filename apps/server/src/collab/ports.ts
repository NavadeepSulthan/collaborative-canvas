import type { AuthenticatedUser } from '@canvas/shared';

/** A connected client as seen by a room. Implemented by the WebSocket transport. */
export interface Peer {
  readonly id: string;
  readonly user: AuthenticatedUser;
  send(message: Uint8Array): void;
  close(code: number, reason: string): void;
}

export const BackplaneKind = { DocUpdate: 0, Awareness: 1, StateVector: 2 } as const;
export type BackplaneKind = (typeof BackplaneKind)[keyof typeof BackplaneKind];

export interface BackplaneMessage {
  /** Node that produced the message; receivers drop their own echoes. */
  origin: string;
  kind: BackplaneKind;
  payload: Uint8Array;
}

export type Unsubscribe = () => Promise<void>;

/** Fan-out bus between horizontally scaled server nodes (Redis Pub/Sub in production). */
export interface Backplane {
  publish(roomKey: string, message: BackplaneMessage): Promise<void>;
  subscribe(roomKey: string, handler: (message: BackplaneMessage) => void): Promise<Unsubscribe>;
  isHealthy(): Promise<boolean>;
  close(): Promise<void>;
}

export interface CompactionResult {
  mergedUpdates: number;
  snapshotBytes: number;
}

/**
 * Append-only delta log plus a periodically compacted snapshot per room.
 * `compact` must be safe to call concurrently from many nodes.
 */
export interface DocumentStore {
  /** Returns the snapshot (if any) followed by all un-compacted updates. */
  load(roomKey: string): Promise<Uint8Array[]>;
  append(roomKey: string, update: Uint8Array): Promise<void>;
  /** Returns null if another node currently holds the compaction lock. */
  compact(
    roomKey: string,
    merge: (updates: Uint8Array[]) => Uint8Array,
  ): Promise<CompactionResult | null>;
  isHealthy(): Promise<boolean>;
  close(): Promise<void>;
}

/** Metrics the collaboration core reports; implemented with prom-client. */
export interface CollabMetrics {
  roomOpened(): void;
  roomClosed(): void;
  peerJoined(): void;
  peerLeft(): void;
  messageReceived(type: string): void;
  backplane(direction: 'in' | 'out'): void;
  persisted(result: 'ok' | 'error', durationSeconds: number): void;
  compacted(result: 'ok' | 'skipped' | 'error'): void;
}
