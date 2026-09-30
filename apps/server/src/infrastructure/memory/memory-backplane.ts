import { EventEmitter } from 'node:events';
import type { Backplane, BackplaneMessage, Unsubscribe } from '../../collab/ports.js';

/**
 * In-process backplane. Several server "nodes" in one process can share one instance,
 * which is how tests prove cross-node convergence without Redis.
 */
export class MemoryBackplane implements Backplane {
  private readonly bus = new EventEmitter().setMaxListeners(0);

  async publish(roomKey: string, message: BackplaneMessage): Promise<void> {
    // Async delivery mimics a real network hop.
    queueMicrotask(() => this.bus.emit(roomKey, { ...message, payload: message.payload.slice() }));
  }

  async subscribe(
    roomKey: string,
    handler: (message: BackplaneMessage) => void,
  ): Promise<Unsubscribe> {
    this.bus.on(roomKey, handler);
    return async () => {
      this.bus.off(roomKey, handler);
    };
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.bus.removeAllListeners();
  }
}
