import { afterEach, describe, expect, it, vi } from 'vitest';
import { Throttle } from './throttle.js';

describe('Throttle', () => {
  afterEach(() => vi.useRealTimers());

  it('runs on the next tick when idle, then coalesces a burst into one trailing run', async () => {
    vi.useFakeTimers();
    let now = 0;
    const run = vi.fn();
    const throttle = new Throttle(25, run, () => now);

    throttle.request();
    await vi.advanceTimersToNextTimerAsync();
    expect(run).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 100; i++) throttle.request();
    now = 25;
    await vi.advanceTimersByTimeAsync(25);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('flush runs pending work immediately and cancel drops it', () => {
    const run = vi.fn();
    const throttle = new Throttle(1000, run, () => 0);
    throttle.request();
    throttle.flush();
    expect(run).toHaveBeenCalledTimes(1);
    throttle.request();
    throttle.cancel();
    throttle.flush();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
