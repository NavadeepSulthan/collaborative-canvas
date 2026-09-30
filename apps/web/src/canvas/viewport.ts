import type { Point } from '@canvas/shared';
import type { Rect } from './geometry';

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;

/**
 * Camera over an infinite world plane.
 * screen = (world - offset) * scale, where `offset` is the world point at the top-left corner.
 */
export class Viewport {
  offsetX = 0;
  offsetY = 0;
  scale = 1;
  width = 0;
  height = 0;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  screenToWorld(p: Point): Point {
    return { x: p.x / this.scale + this.offsetX, y: p.y / this.scale + this.offsetY };
  }

  worldToScreen(p: Point): Point {
    return { x: (p.x - this.offsetX) * this.scale, y: (p.y - this.offsetY) * this.scale };
  }

  worldRectToScreen(rect: Rect): Rect {
    const topLeft = this.worldToScreen(rect);
    return { ...topLeft, width: rect.width * this.scale, height: rect.height * this.scale };
  }

  panByScreen(dx: number, dy: number): void {
    this.offsetX -= dx / this.scale;
    this.offsetY -= dy / this.scale;
  }

  /** Zooms keeping the world point under `anchor` (screen coords) fixed. */
  zoomAt(anchor: Point, factor: number): void {
    const before = this.screenToWorld(anchor);
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    const after = this.screenToWorld(anchor);
    this.offsetX += before.x - after.x;
    this.offsetY += before.y - after.y;
  }

  visibleWorldRect(): Rect {
    return {
      x: this.offsetX,
      y: this.offsetY,
      width: this.width / this.scale,
      height: this.height / this.scale,
    };
  }
}
