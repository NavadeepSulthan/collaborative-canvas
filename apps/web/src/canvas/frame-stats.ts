export interface FrameStatsSnapshot {
  fps: number;
  p95FrameMs: number;
  lastDrawMs: number;
  drawnShapes: number;
}

/** Rolling window of frame timings for the on-screen performance panel and benchmark. */
export class FrameStats {
  private readonly intervals: number[] = [];
  private readonly drawTimes: number[] = [];
  private lastFrameAt: number | null = null;
  private drawnShapes = 0;

  constructor(private readonly windowSize = 120) {}

  record(frameStart: number, drawMs: number, drawnShapes: number): void {
    if (this.lastFrameAt !== null)
      push(this.intervals, frameStart - this.lastFrameAt, this.windowSize);
    this.lastFrameAt = frameStart;
    push(this.drawTimes, drawMs, this.windowSize);
    this.drawnShapes = drawnShapes;
  }

  /** Call when the loop goes idle so the next frame doesn't count the idle gap. */
  pause(): void {
    this.lastFrameAt = null;
  }

  reset(): void {
    this.intervals.length = 0;
    this.drawTimes.length = 0;
    this.lastFrameAt = null;
  }

  snapshot(): FrameStatsSnapshot {
    const avgInterval = average(this.intervals);
    return {
      fps: avgInterval > 0 ? Math.round(1000 / avgInterval) : 0,
      p95FrameMs: round(percentile(this.drawTimes, 0.95)),
      lastDrawMs: round(this.drawTimes.at(-1) ?? 0),
      drawnShapes: this.drawnShapes,
    };
  }
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

function average(values: readonly number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function push(values: number[], value: number, max: number): void {
  values.push(value);
  if (values.length > max) values.shift();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
