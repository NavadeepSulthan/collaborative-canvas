import type { Point } from '@canvas/shared';
import type { Rect } from './geometry';

/**
 * Uniform-grid spatial hash. Viewport culling and hit testing become proportional to what's
 * on screen instead of the total number of shapes, which is what keeps 10k+ objects at 60 FPS.
 */
export class SpatialHash {
  private readonly cells = new Map<string, Set<string>>();
  private readonly cellsById = new Map<string, string[]>();
  private readonly rects = new Map<string, Rect>();

  constructor(private readonly cellSize = 256) {}

  get size(): number {
    return this.cellsById.size;
  }

  /** Bounds last indexed for `id` (e.g. a shape's position before an edit). */
  boundsOf(id: string): Rect | undefined {
    return this.rects.get(id);
  }

  upsert(id: string, rect: Rect): void {
    this.remove(id);
    this.rects.set(id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    const keys = this.keysFor(rect);
    for (const key of keys) {
      let cell = this.cells.get(key);
      if (!cell) {
        cell = new Set();
        this.cells.set(key, cell);
      }
      cell.add(id);
    }
    this.cellsById.set(id, keys);
  }

  remove(id: string): void {
    const keys = this.cellsById.get(id);
    if (!keys) return;
    for (const key of keys) {
      const cell = this.cells.get(key);
      cell?.delete(id);
      if (cell?.size === 0) this.cells.delete(key);
    }
    this.cellsById.delete(id);
    this.rects.delete(id);
  }

  clear(): void {
    this.cells.clear();
    this.cellsById.clear();
    this.rects.clear();
  }

  /** Candidate ids whose cells overlap `rect` (callers do the exact test). */
  query(rect: Rect): Set<string> {
    const result = new Set<string>();
    for (const key of this.keysFor(rect)) {
      this.cells.get(key)?.forEach((id) => result.add(id));
    }
    return result;
  }

  queryPoint(p: Point): Set<string> {
    return this.query({ x: p.x, y: p.y, width: 0, height: 0 });
  }

  private keysFor(rect: Rect): string[] {
    const minX = Math.floor(rect.x / this.cellSize);
    const minY = Math.floor(rect.y / this.cellSize);
    const maxX = Math.floor((rect.x + rect.width) / this.cellSize);
    const maxY = Math.floor((rect.y + rect.height) / this.cellSize);
    const keys: string[] = [];
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) keys.push(`${cx}:${cy}`);
    }
    return keys;
  }
}
