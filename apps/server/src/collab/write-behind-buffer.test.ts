import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WriteBehindBuffer } from './write-behind-buffer.js';

function updateSetting(key: string, value: number): Uint8Array {
  const doc = new Y.Doc();
  let captured: Uint8Array | undefined;
  doc.on('update', (u: Uint8Array) => (captured = u));
  doc.getMap('m').set(key, value);
  return captured!;
}

describe('WriteBehindBuffer', () => {
  afterEach(() => vi.useRealTimers());

  it('merges bursts of updates into a single write', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const buffer = new WriteBehindBuffer({
      debounceMs: 1000,
      write,
      onWritten: vi.fn(),
      onError: vi.fn(),
    });

    buffer.push(updateSetting('a', 1));
    buffer.push(updateSetting('b', 2));
    buffer.push(updateSetting('c', 3));
    await buffer.flush();

    expect(write).toHaveBeenCalledTimes(1);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, write.mock.calls[0]![0] as Uint8Array);
    expect(doc.getMap('m').toJSON()).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('re-queues a failed write and retries with backoff', async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    const onError = vi.fn();
    const onWritten = vi.fn();
    const buffer = new WriteBehindBuffer({ debounceMs: 10, write, onWritten, onError });

    buffer.push(updateSetting('a', 1));
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(buffer.hasPending).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(onWritten).toHaveBeenCalledTimes(1);
    expect(buffer.hasPending).toBe(false);
  });

  it('serializes concurrent flushes', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    const write = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (write.mock.calls.length === 1) await firstGate;
      inFlight--;
    });
    const buffer = new WriteBehindBuffer({
      debounceMs: 1000,
      write,
      onWritten: vi.fn(),
      onError: vi.fn(),
    });
    buffer.push(updateSetting('a', 1));
    const first = buffer.flush();
    await vi.waitFor(() => expect(inFlight).toBe(1));
    buffer.push(updateSetting('b', 2));
    const second = buffer.flush();
    releaseFirst();
    await Promise.all([first, second]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
  });
});
