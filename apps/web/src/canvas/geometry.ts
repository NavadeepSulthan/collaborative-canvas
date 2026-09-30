import type { Point, Shape } from '@canvas/shared';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

export function rectContains(rect: Rect, p: Point): boolean {
  return (
    p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height
  );
}

/** Precise hit test: ellipses use the implicit equation, everything else its bounding box. */
export function shapeContains(shape: Shape, p: Point): boolean {
  if (shape.kind !== 'ellipse') return rectContains(shape, p);
  const rx = shape.width / 2;
  const ry = shape.height / 2;
  if (rx === 0 || ry === 0) return false;
  const dx = (p.x - (shape.x + rx)) / rx;
  const dy = (p.y - (shape.y + ry)) / ry;
  return dx * dx + dy * dy <= 1;
}

export function boundsOf(shapes: Iterable<Rect>): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of shapes) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.width);
    maxY = Math.max(maxY, s.y + s.height);
  }
  return Number.isFinite(minX)
    ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    : null;
}
