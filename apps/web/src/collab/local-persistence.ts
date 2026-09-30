import * as Y from 'yjs';

export type PersistenceRequest =
  | { type: 'open'; name: string }
  | { type: 'append'; update: Uint8Array }
  | { type: 'flush'; id: number };

export type PersistenceResponse =
  | { type: 'loaded'; updates: Uint8Array[] }
  | { type: 'flushed'; id: number }
  | { type: 'error'; message: string };

const FLUSH_TIMEOUT_MS = 2000;

/**
 * Offline copy of the document in IndexedDB, with all I/O, merging and compaction done in a
 * Web Worker. The main thread only posts each small update, so a huge board never blocks
 * rendering (y-indexeddb re-encodes the entire document on the main thread every 500 updates).
 */
export class LocalPersistence {
  readonly whenLoaded: Promise<void>;
  private readonly worker: Worker;
  private readonly flushes = new Map<number, () => void>();
  private nextFlushId = 0;

  constructor(
    name: string,
    private readonly doc: Y.Doc,
  ) {
    this.worker = new Worker(new URL('./persistence.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.whenLoaded = new Promise((resolve) => {
      this.worker.onmessage = ({ data }: MessageEvent<PersistenceResponse>) => {
        switch (data.type) {
          case 'loaded':
            if (data.updates.length > 0) {
              doc.transact(() => data.updates.forEach((u) => Y.applyUpdate(doc, u, this)), this);
            }
            resolve();
            break;
          case 'flushed':
            this.flushes.get(data.id)?.();
            this.flushes.delete(data.id);
            break;
          case 'error':
            console.error('[local-persistence]', data.message);
            resolve();
            break;
        }
      };
    });
    // Subscribed before loading completes so edits made while loading are kept too.
    doc.on('update', this.onUpdate);
    this.post({ type: 'open', name });
  }

  /** Writes anything buffered, then stops the worker. */
  async destroy(): Promise<void> {
    this.doc.off('update', this.onUpdate);
    const id = this.nextFlushId++;
    await Promise.race([
      new Promise<void>((resolve) => {
        this.flushes.set(id, resolve);
        this.post({ type: 'flush', id });
      }),
      new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
    ]);
    this.worker.terminate();
  }

  private readonly onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== this) this.post({ type: 'append', update });
  };

  private post(message: PersistenceRequest): void {
    this.worker.postMessage(message);
  }
}
