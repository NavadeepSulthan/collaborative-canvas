/**
 * Leading + trailing throttle: the first request after a quiet period runs on the next tick
 * (no added latency), further requests within `intervalMs` coalesce into one trailing run.
 */
export class Throttle {
  private immediate: NodeJS.Immediate | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private lastRun = -Infinity;

  constructor(
    private readonly intervalMs: number,
    private readonly run: () => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  request(): void {
    if (this.immediate || this.timeout) return;
    const wait = this.lastRun + this.intervalMs - this.now();
    if (wait <= 0) {
      this.immediate = setImmediate(this.fire);
    } else {
      this.timeout = setTimeout(this.fire, wait);
      this.timeout.unref();
    }
  }

  /** Runs now if anything is pending (used before eviction/shutdown). */
  flush(): void {
    if (!this.immediate && !this.timeout) return;
    this.cancel();
    this.fire();
  }

  cancel(): void {
    if (this.immediate) clearImmediate(this.immediate);
    if (this.timeout) clearTimeout(this.timeout);
    this.immediate = null;
    this.timeout = null;
  }

  private readonly fire = (): void => {
    this.immediate = null;
    this.timeout = null;
    this.lastRun = this.now();
    this.run();
  };
}
