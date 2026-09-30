import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { compactRows } from '../collab/compact-rows';
import { exposedStrips, worldToDeviceRect } from './shape-layer';

describe('exposedStrips', () => {
  const area = (strips: { width: number; height: number }[]) =>
    strips.reduce((sum, s) => sum + s.width * s.height, 0);

  it('covers exactly the uncovered area without overlap', () => {
    const [w, h] = [800, 600];
    for (const [dx, dy] of [
      [10, 0],
      [-10, 0],
      [0, 7],
      [0, -7],
      [13, -9],
      [-5, 5],
    ] as const) {
      expect(area(exposedStrips(dx, dy, w, h))).toBe(
        w * h - (w - Math.abs(dx)) * (h - Math.abs(dy)),
      );
    }
  });

  it('returns nothing when the bitmap did not move', () => {
    expect(exposedStrips(0, 0, 800, 600)).toEqual([]);
  });
});

describe('worldToDeviceRect', () => {
  const camera = { offsetX: 100, offsetY: 50, scale: 2 };

  it('maps world rects to device pixels, rounding outward with a 1px anti-alias margin', () => {
    expect(
      worldToDeviceRect({ x: 110, y: 60, width: 10, height: 5 }, camera, 1, 1000, 1000),
    ).toEqual({
      x: 19,
      y: 19,
      width: 22,
      height: 12,
    });
  });

  it('clamps to the canvas and rejects rects that are fully off-screen', () => {
    expect(
      worldToDeviceRect({ x: 0, y: 0, width: 60, height: 30 }, camera, 1, 1000, 1000),
    ).toBeNull();
    expect(
      worldToDeviceRect({ x: 90, y: 40, width: 1000, height: 1000 }, camera, 2, 400, 300),
    ).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
  });
});

describe('compactRows', () => {
  it('folds many stored updates into one equivalent, smaller update', () => {
    const doc = new Y.Doc();
    const rows: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => rows.push(u));
    const map = doc.getMap<number>('shapes');
    for (let i = 0; i < 200; i++) map.set(`s${i % 20}`, i);
    for (let i = 0; i < 10; i++) map.delete(`s${i}`);

    const compacted = compactRows(rows);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, compacted);
    expect(restored.getMap('shapes').toJSON()).toEqual(map.toJSON());
    expect(compacted.byteLength).toBeLessThan(rows.reduce((n, r) => n + r.byteLength, 0));
  });
});
