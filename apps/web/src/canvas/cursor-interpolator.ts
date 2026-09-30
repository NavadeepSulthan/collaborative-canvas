import type { Point } from '@canvas/shared';

interface Track {
  current: Point;
  target: Point;
}

/**
 * Remote cursors arrive ~20 times/second; drawing them at those positions looks jumpy.
 * Each frame moves the rendered cursor a time-based fraction toward its latest target
 * (exponential smoothing), which is frame-rate independent.
 */
export class CursorInterpolator {
  private readonly tracks = new Map<number, Track>();

  constructor(private readonly timeConstantMs = 60) {}

  setTarget(id: number, target: Point): void {
    const track = this.tracks.get(id);
    if (track) track.target = target;
    else this.tracks.set(id, { current: { ...target }, target });
  }

  remove(id: number): void {
    this.tracks.delete(id);
  }

  retainOnly(ids: Set<number>): void {
    for (const id of this.tracks.keys()) if (!ids.has(id)) this.tracks.delete(id);
  }

  get(id: number): Point | undefined {
    return this.tracks.get(id)?.current;
  }

  /** Advances all cursors by `dtMs`. Returns true while any cursor is still moving. */
  step(dtMs: number): boolean {
    const alpha = 1 - Math.exp(-dtMs / this.timeConstantMs);
    let moving = false;
    for (const track of this.tracks.values()) {
      const dx = track.target.x - track.current.x;
      const dy = track.target.y - track.current.y;
      if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
        track.current = { ...track.target };
        continue;
      }
      track.current = { x: track.current.x + dx * alpha, y: track.current.y + dy * alpha };
      moving = true;
    }
    return moving;
  }
}
