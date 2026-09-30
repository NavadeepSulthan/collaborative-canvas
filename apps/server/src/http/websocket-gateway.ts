import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  CloseCode,
  COLLAB_PATH_PREFIX,
  roomKey,
  slugSchema,
  type AuthenticatedUser,
} from '@canvas/shared';
import { context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { ProtocolError, type Room } from '../collab/room.js';
import type { RoomRegistry } from '../collab/room-registry.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../observability/logger.js';
import { tracer } from '../observability/tracing.js';
import { TokenBucket } from './token-bucket.js';
import type { TokenService } from './token-service.js';
import { WebSocketPeer } from './websocket-peer.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const RATE_LIMIT_BURST = 400;
const RATE_LIMIT_PER_SECOND = 200;

export interface WebSocketGatewayDeps {
  config: AppConfig;
  tokens: TokenService;
  rooms: RoomRegistry;
  logger: Logger;
}

type Admission =
  | { ok: true; user: AuthenticatedUser; roomId: string }
  | { ok: false; code: number; reason: string };

/**
 * Upgrades HTTP requests on /collab/:roomId to WebSockets and wires them to rooms.
 *
 * Browsers can't read HTTP status codes from a failed handshake, so auth failures are
 * reported by completing the upgrade and closing with an application code (4401/4403)
 * that tells the client not to retry.
 */
export class WebSocketGateway {
  private readonly wss: WebSocketServer;
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private readonly heartbeat: NodeJS.Timeout;
  private draining = false;

  constructor(private readonly deps: WebSocketGatewayDeps) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: deps.config.maxMessageBytes });
    this.heartbeat = setInterval(() => this.checkHeartbeats(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref();
  }

  get connectionCount(): number {
    return this.wss.clients.size;
  }

  readonly handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', (err) => this.deps.logger.debug({ err }, 'upgrade socket error'));
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(`${COLLAB_PATH_PREFIX}/`)) {
      return rejectHandshake(socket, 404, 'Not Found');
    }
    // Cross-site WebSocket hijacking protection: browsers always send Origin.
    const origin = req.headers.origin;
    if (origin && !this.deps.config.allowedOrigins.has(origin)) {
      return rejectHandshake(socket, 403, 'Forbidden');
    }
    if (this.draining) {
      return rejectHandshake(socket, 503, 'Service Unavailable');
    }

    const traceparent = url.searchParams.get('traceparent');
    const parent = traceparent ? propagation.extract(ROOT_CONTEXT, { traceparent }) : ROOT_CONTEXT;
    const span = tracer.startSpan('ws.upgrade', {}, parent);

    void context.with(trace.setSpan(parent, span), async () => {
      try {
        const admission = await this.admit(url);
        if (!admission.ok) {
          span.setAttribute('ws.rejected', admission.reason);
          return this.wss.handleUpgrade(req, socket, head, (ws) =>
            ws.close(admission.code, admission.reason),
          );
        }
        const { user, roomId } = admission;
        const key = roomKey(user.tenantId, roomId);
        span.setAttributes({
          'collab.room': key,
          'collab.user': user.id,
          'collab.role': user.role,
        });

        let room: Room;
        try {
          room = await this.deps.rooms.acquire(key);
        } catch (err) {
          this.deps.logger.error({ err, room: key }, 'failed to load room');
          return this.wss.handleUpgrade(req, socket, head, (ws) =>
            ws.close(CloseCode.TryAgainLater, 'room unavailable'),
          );
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, room, key, user));
      } finally {
        span.end();
      }
    });
  };

  /** Stops accepting sockets and asks clients to reconnect (to another replica). */
  async close(): Promise<void> {
    this.draining = true;
    clearInterval(this.heartbeat);
    for (const ws of this.wss.clients) ws.close(CloseCode.ServiceRestart, 'server restarting');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private async admit(url: URL): Promise<Admission> {
    const roomId = safeDecode(url.pathname.slice(COLLAB_PATH_PREFIX.length + 1));
    if (!roomId || !slugSchema.safeParse(roomId).success) {
      return { ok: false, code: CloseCode.BadRequest, reason: 'invalid room id' };
    }
    const token = url.searchParams.get('token');
    if (!token) return { ok: false, code: CloseCode.Unauthorized, reason: 'missing token' };
    try {
      return { ok: true, user: await this.deps.tokens.verify(token), roomId };
    } catch {
      return { ok: false, code: CloseCode.Unauthorized, reason: 'invalid token' };
    }
  }

  private attach(ws: WebSocket, room: Room, key: string, user: AuthenticatedUser): void {
    const peer = new WebSocketPeer(ws, user, MAX_BUFFERED_BYTES);
    const bucket = new TokenBucket(RATE_LIMIT_BURST, RATE_LIMIT_PER_SECOND);
    const log = this.deps.logger.child({ room: key, user_id: user.id, peer_id: peer.id });

    this.alive.set(ws, true);
    ws.on('pong', () => this.alive.set(ws, true));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return peer.close(CloseCode.BadRequest, 'binary frames only');
      if (!bucket.tryRemove()) return peer.close(CloseCode.PolicyViolation, 'rate limit exceeded');
      try {
        room.handleMessage(peer, toUint8Array(data));
      } catch (err) {
        if (err instanceof ProtocolError) {
          log.warn({ err }, 'protocol error');
          peer.close(CloseCode.BadRequest, 'protocol error');
        } else {
          log.error({ err }, 'unexpected error handling message');
          peer.close(1011, 'internal error');
        }
      }
    });
    ws.on('close', (code) => {
      room.leave(peer);
      this.deps.rooms.release(key);
      log.info({ code }, 'peer disconnected');
    });
    ws.on('error', (err) => log.warn({ err }, 'socket error'));

    room.join(peer);
    log.info({ role: user.role, peers: room.peerCount }, 'peer connected');
  }

  private checkHeartbeats(): void {
    for (const ws of this.wss.clients) {
      if (!this.alive.get(ws)) {
        ws.terminate();
        continue;
      }
      this.alive.set(ws, false);
      ws.ping();
    }
  }
}

function rejectHandshake(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function toUint8Array(data: RawData): Uint8Array {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
