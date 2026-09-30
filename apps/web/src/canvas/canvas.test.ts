import { describe, expect, it } from 'vitest';
import { CursorInterpolator } from './cursor-interpolator';
import { percentile } from './frame-stats';
import { intersects, rectFromPoints, shapeContains } from './geometry';
import { SpatialHash } from './spatial-index';
import { Viewport } from './viewport';

describe('Viewport', () => {
  it('round-trips screen and world coordinates', () => {
    const v = new Viewport();
    v.offsetX = 100;
    v.offsetY = -50;
    v.scale = 2;
    const world = { x: 123, y: 456 };
    expect(v.screenToWorld(v.worldToScreen(world))).toEqual(world);
  });

  it('keeps the anchor point fixed while zooming', () => {
    const v = new Viewport();
    v.resize(800, 600);
    const anchor = { x: 200, y: 150 };
    const before = v.screenToWorld(anchor);
    v.zoomAt(anchor, 3);
    const after = v.screenToWorld(anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(v.scale).toBe(3);
  });

  it('clamps zoom', () => {
    const v = new Viewport();
    v.zoomAt({ x: 0, y: 0 }, 1000);
    expect(v.scale).toBe(8);
  });
});

describe('SpatialHash', () => {
  it('returns only shapes near the query rect', () => {
    const index = new SpatialHash(100);
    index.upsert('near', { x: 10, y: 10, width: 20, height: 20 });
    index.upsert('far', { x: 5000, y: 5000, width: 20, height: 20 });
    index.upsert('big', { x: -500, y: -500, width: 1000, height: 1000 });
    expect([...index.query({ x: 0, y: 0, width: 50, height: 50 })].sort()).toEqual(['big', 'near']);
  });

  it('moves and removes entries', () => {
    const index = new SpatialHash(100);
    index.upsert('a', { x: 0, y: 0, width: 10, height: 10 });
    index.upsert('a', { x: 1000, y: 1000, width: 10, height: 10 });
    expect(index.queryPoint({ x: 5, y: 5 }).size).toBe(0);
    expect(index.queryPoint({ x: 1005, y: 1005 }).has('a')).toBe(true);
    index.remove('a');
    expect(index.size).toBe(0);
  });

  it('scales: querying a small area among 50k shapes touches few candidates', () => {
    const index = new SpatialHash(256);
    for (let i = 0; i < 50_000; i++) {
      index.upsert(String(i), {
        x: (i % 500) * 100,
        y: Math.floor(i / 500) * 100,
        width: 50,
        height: 50,
      });
    }
    expect(index.query({ x: 0, y: 0, width: 500, height: 500 }).size).toBeLessThan(200);
  });
});

describe('geometry', () => {
  const ellipse = {
    id: 'e',
    kind: 'ellipse' as const,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    fill: '',
    z: 0,
    text: '',
  };

  it('hit-tests ellipses precisely (corners of the bounding box miss)', () => {
    expect(shapeContains(ellipse, { x: 50, y: 25 })).toBe(true);
    expect(shapeContains(ellipse, { x: 2, y: 2 })).toBe(false);
  });

  it('normalizes rects drawn in any direction', () => {
    expect(rectFromPoints({ x: 10, y: 10 }, { x: 0, y: 30 })).toEqual({
      x: 0,
      y: 10,
      width: 10,
      height: 20,
    });
  });

  it('detects intersection', () => {
    expect(
      intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }),
    ).toBe(true);
    expect(
      intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 11, y: 0, width: 5, height: 5 }),
    ).toBe(false);
  });
});

describe('CursorInterpolator', () => {
  it('snaps new cursors, then glides toward updated targets', () => {
    const interp = new CursorInterpolator(60);
    interp.setTarget(1, { x: 0, y: 0 });
    expect(interp.get(1)).toEqual({ x: 0, y: 0 });

    interp.setTarget(1, { x: 100, y: 0 });
    expect(interp.step(16)).toBe(true);
    const mid = interp.get(1)!.x;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);

    for (let i = 0; i < 100; i++) interp.step(16);
    expect(interp.get(1)).toEqual({ x: 100, y: 0 });
    expect(interp.step(16)).toBe(false);
  });
});

describe('percentile', () => {
  it('computes nearest-rank percentiles', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile([], 0.95)).toBe(0);
  });
});
