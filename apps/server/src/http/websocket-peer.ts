import { randomUUID } from 'node:crypto';
import { CloseCode, type AuthenticatedUser } from '@canvas/shared';
import { WebSocket } from 'ws';
import type { Peer } from '../collab/ports.js';

/** Adapts a `ws` socket to the room's Peer interface and enforces outbound backpressure. */
export class WebSocketPeer implements Peer {
  readonly id = randomUUID();

  constructor(
    private readonly socket: WebSocket,
    readonly user: AuthenticatedUser,
    private readonly maxBufferedBytes: number,
  ) {}

  send(message: Uint8Array): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    // A client that can't keep up would otherwise grow server memory without bound.
    if (this.socket.bufferedAmount > this.maxBufferedBytes) {
      this.close(CloseCode.TryAgainLater, 'client too slow');
      return;
    }
    this.socket.send(message, { binary: true }, (error) => {
      if (error) this.socket.terminate();
    });
  }

  close(code: number, reason: string): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(code, reason);
    }
  }
}
