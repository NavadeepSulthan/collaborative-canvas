/** Classic token bucket: `capacity` burst, refilled continuously at `refillPerSecond`. */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  tryRemove(count = 1): boolean {
    const current = this.now();
    const elapsedSeconds = (current - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = current;
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
}
