import { DOC_KEYS, type AuthenticatedUser } from '@canvas/shared';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { toWebSocketUrl } from '../config';
import { createTraceparent } from '../observability/trace-context';
import { LocalPersistence } from './local-persistence';
import { PresenceController } from './presence';
import { LOCAL_ORIGIN, ShapeStore } from './shape-store';

export interface SessionInfo {
  serverUrl: string;
  roomId: string;
  token: string;
  expiresAt: string;
  user: AuthenticatedUser;
  color: string;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'rejected';

export interface SessionState {
  status: ConnectionStatus;
  /** Server state has been merged into the local doc at least once on this connection. */
  synced: boolean;
  /** Local IndexedDB copy has been loaded (edits made offline survive reloads). */
  offlineReady: boolean;
  rejectionReason: string | null;
}

/**
 * One open document: local-first Y.Doc + IndexedDB persistence + WebSocket sync + presence.
 * Edits apply to the local doc immediately (zero latency) and sync whenever a connection exists.
 */
export class CollabSession {
  readonly doc = new Y.Doc();
  readonly shapes: ShapeStore;
  readonly presence: PresenceController;
  readonly undoManager: Y.UndoManager;
  readonly traceparent = createTraceparent();
  private readonly provider: WebsocketProvider;
  private readonly local: LocalPersistence;
  private readonly listeners = new Set<() => void>();
  private state: SessionState = {
    status: 'connecting',
    synced: false,
    offlineReady: false,
    rejectionReason: null,
  };

  constructor(readonly info: SessionInfo) {
    this.shapes = new ShapeStore(this.doc);
    this.undoManager = new Y.UndoManager(this.doc.getMap(DOC_KEYS.shapes), {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 400,
    });

    this.local = new LocalPersistence(
      `collab-canvas:${info.user.tenantId}:${info.roomId}`,
      this.doc,
    );
    void this.local.whenLoaded.then(() => this.setState({ offlineReady: true }));

    this.provider = new WebsocketProvider(toWebSocketUrl(info.serverUrl), info.roomId, this.doc, {
      params: { token: info.token, traceparent: this.traceparent },
      maxBackoffTime: 10_000,
    });
    this.provider.on('status', ({ status }) => this.setState({ status }));
    this.provider.on('sync', (synced: boolean) => this.setState({ synced }));
    this.provider.on('closed', ({ code, reason }) =>
      this.setState({ status: 'rejected', rejectionReason: `${reason || 'rejected'} (${code})` }),
    );

    this.presence = new PresenceController(this.provider.awareness, {
      id: info.user.id,
      name: info.user.name,
      color: info.color,
    });
  }

  get readOnly(): boolean {
    return this.info.user.role === 'viewer';
  }

  getState = (): SessionState => this.state;

  /** Drops or restores the server connection; local editing continues either way. */
  setNetworkEnabled(enabled: boolean): void {
    if (enabled) this.provider.connect();
    else this.provider.disconnect();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  destroy(): void {
    this.presence.destroy();
    this.undoManager.destroy();
    this.shapes.destroy();
    this.provider.destroy();
    void this.local.destroy();
    this.doc.destroy();
    this.listeners.clear();
  }

  private setState(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
