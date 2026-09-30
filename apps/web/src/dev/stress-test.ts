import { SHAPE_KINDS } from '@canvas/shared';
import type { Rect } from '../canvas/geometry';
import type { NewShape } from '../collab/shape-store';
import { FILL_COLORS } from '../ui/colors';

/** Random shapes spread over (and beyond) the visible area, for load/perf testing. */
export function generateShapes(count: number, around: Rect): NewShape[] {
  const spread = Math.max(around.width, around.height) * 3;
  const centerX = around.x + around.width / 2;
  const centerY = around.y + around.height / 2;
  return Array.from({ length: count }, (_, i) => {
    const kind = SHAPE_KINDS[i % 2]!;
    return {
      kind,
      x: centerX + (Math.random() - 0.5) * spread,
      y: centerY + (Math.random() - 0.5) * spread,
      width: 20 + Math.random() * 80,
      height: 20 + Math.random() * 80,
      fill: FILL_COLORS[i % FILL_COLORS.length]!,
    };
  });
}
