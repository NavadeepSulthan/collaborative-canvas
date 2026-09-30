import { Redis } from 'ioredis';
import { decodeEnvelope, encodeEnvelope } from '../../collab/envelope.js';
import type { Backplane, BackplaneMessage, Unsubscribe } from '../../collab/ports.js';
import type { Logger } from '../../observability/logger.js';

const CHANNEL_PREFIX = 'collab:room:';

/**
 * Redis Pub/Sub backplane. Pub/Sub is fire-and-forget; rooms repair any dropped message
 * through periodic state-vector anti-entropy (see Room.announceStateVector).
 */
export class RedisBackplane implements Backplane {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly handlers = new Map<string, Set<(message: BackplaneMessage) => void>>();

  constructor(
    url: string,
    private readonly logger: Logger,
  ) {
    const options = { maxRetriesPerRequest: 3, lazyConnect: false } as const;
    this.publisher = new Redis(url, options);
    this.subscriber = new Redis(url, options);
    for (const client of [this.publisher, this.subscriber]) {
      client.on('error', (err: Error) => this.logger.error({ err }, 'redis error'));
    }
    this.subscriber.on('messageBuffer', (channel: Buffer, data: Buffer) => {
      const roomKey = channel.toString().slice(CHANNEL_PREFIX.length);
      const handlers = this.handlers.get(roomKey);
      if (!handlers) return;
      let message: BackplaneMessage;
      try {
        message = decodeEnvelope(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } catch (err) {
        this.logger.warn({ err, roomKey }, 'dropping malformed backplane message');
        return;
      }
      handlers.forEach((handler) => handler(message));
    });
  }

  async publish(roomKey: string, message: BackplaneMessage): Promise<void> {
    await this.publisher.publish(CHANNEL_PREFIX + roomKey, Buffer.from(encodeEnvelope(message)));
  }

  async subscribe(
    roomKey: string,
    handler: (message: BackplaneMessage) => void,
  ): Promise<Unsubscribe> {
    let handlers = this.handlers.get(roomKey);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(roomKey, handlers);
      await this.subscriber.subscribe(CHANNEL_PREFIX + roomKey);
    }
    handlers.add(handler);
    return async () => {
      const current = this.handlers.get(roomKey);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(roomKey);
        await this.subscriber.unsubscribe(CHANNEL_PREFIX + roomKey);
      }
    };
  }

  async isHealthy(): Promise<boolean> {
    try {
      return (await this.publisher.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.subscriber.quit(), this.publisher.quit()]);
  }
}
