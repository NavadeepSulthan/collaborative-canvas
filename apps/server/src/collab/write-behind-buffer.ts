import * as Y from 'yjs';

export interface WriteBehindOptions {
  debounceMs: number;
  maxBackoffMs?: number;
  write(update: Uint8Array): Promise<void>;
  onWritten(durationSeconds: number): void;
  onError(error: unknown, durationSeconds: number): void;
}

/**
 * Debounced, serialized write-behind buffer for Yjs updates.
 * Keystroke-sized updates are merged into one row per flush, and failed writes are
 * re-queued with exponential backoff so a database blip never drops edits.
 */
export class WriteBehindBuffer {
  private pending: Uint8Array[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failures = 0;

  constructor(private readonly options: WriteBehindOptions) {}

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  push(update: Uint8Array): void {
    this.pending.push(update);
    this.schedule(this.options.debounceMs);
  }

  /** Writes everything buffered so far. Resolves even if the write failed (check `hasPending`). */
  flush(): Promise<void> {
    this.clearTimer();
    this.chain = this.chain.then(() => this.drain());
    return this.chain;
  }

  dispose(): void {
    this.clearTimer();
  }

  private async drain(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    const merged = batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch);
    const started = performance.now();
    try {
      await this.options.write(merged);
      this.failures = 0;
      this.options.onWritten((performance.now() - started) / 1000);
    } catch (error) {
      this.pending.unshift(merged);
      this.failures += 1;
      this.options.onError(error, (performance.now() - started) / 1000);
      const backoff = Math.min(this.options.maxBackoffMs ?? 30_000, 250 * 2 ** this.failures);
      this.schedule(backoff);
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
