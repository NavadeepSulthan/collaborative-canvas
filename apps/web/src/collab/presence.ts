import type { Point, PresenceState, PresenceUser } from '@canvas/shared';
import type { Awareness } from 'y-protocols/awareness';

export const MAX_SHARED_SELECTION = 200;

export interface RemotePeer extends PresenceState {
  clientId: number;
}

/**
 * Publishes this user's cursor/selection through Yjs awareness (ephemeral, never persisted)
 * and exposes validated remote peers. Cursor updates are throttled so a 120 Hz mouse doesn't
 * produce 120 network messages per second.
 */
export class PresenceController {
  private pendingCursor: Point | null | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private peersCache: RemotePeer[] | null = null;

  constructor(
    private readonly awareness: Awareness,
    user: PresenceUser,
    private readonly cursorIntervalMs = 50,
  ) {
    const initial: PresenceState = { user, cursor: null, selection: [] };
    awareness.setLocalState(initial);
    awareness.on('change', this.invalidate);
  }

  setCursor(cursor: Point | null): void {
    this.pendingCursor = cursor;
    if (this.timer) return;
    this.flushCursor();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pendingCursor !== undefined) this.flushCursor();
    }, this.cursorIntervalMs);
  }

  setSelection(selection: readonly string[]): void {
    // Presence is re-sent in full on every cursor move, so a select-all of a huge board must not ride along.
    this.awareness.setLocalStateField('selection', selection.slice(0, MAX_SHARED_SELECTION));
  }

  /** Remote peers (excluding this client). Stable reference until presence changes. */
  getPeers = (): RemotePeer[] => {
    if (this.peersCache) return this.peersCache;
    const peers: RemotePeer[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.awareness.clientID || !isPresenceState(state)) return;
      peers.push({ clientId, ...state });
    });
    this.peersCache = peers;
    return peers;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.awareness.on('change', listener);
    return () => this.awareness.off('change', listener);
  };

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.awareness.off('change', this.invalidate);
    this.awareness.setLocalState(null);
  }

  private flushCursor(): void {
    const cursor = this.pendingCursor;
    this.pendingCursor = undefined;
    if (cursor === undefined) return;
    this.awareness.setLocalStateField('cursor', cursor);
  }

  private readonly invalidate = (): void => {
    this.peersCache = null;
  };
}

/** Awareness state comes from other clients, so validate before trusting its shape. */
function isPresenceState(value: unknown): value is PresenceState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<PresenceState>;
  return (
    typeof state.user?.id === 'string' &&
    typeof state.user.name === 'string' &&
    typeof state.user.color === 'string' &&
    Array.isArray(state.selection) &&
    (state.cursor === null ||
      (typeof state.cursor?.x === 'number' && typeof state.cursor.y === 'number'))
  );
}
