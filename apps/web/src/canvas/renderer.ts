import type { Point, Shape, ShapeKind } from '@canvas/shared';
import type { Rect } from './geometry';
import type { Viewport } from './viewport';

export const HANDLE_SCREEN_PX = 10;
const BACKGROUND = '#f8fafc';
const GRID = '#e2e8f0';
const SELECTION = '#2563eb';
const TEXT = '#1f2937';
const NOTE_FONT = '16px system-ui, -apple-system, sans-serif';
const NOTE_PADDING = 10;
const NOTE_LINE_HEIGHT = 20;
/** Below this zoom level text is skipped (level of detail). */
const LOW_DETAIL_SCALE = 0.35;
/** Ellipses smaller than this on screen are drawn as rectangles (indistinguishable, far cheaper). */
const MIN_ELLIPSE_SCREEN_PX = 4;
const TEXT_CACHE_LIMIT = 5000;
/** Beyond this many selected shapes, draw one bounding box instead of one outline each. */
export const MAX_OUTLINED_SELECTION = 500;

export interface RemoteOverlay {
  name: string;
  color: string;
  cursor: Point | null;
  selection: Shape[];
}

export interface OverlayModel {
  viewport: Viewport;
  dpr: number;
  selected: readonly Shape[];
  selectionBounds: Rect | null;
  showResizeHandle: boolean;
  remotes: readonly RemoteOverlay[];
  draft: { kind: ShapeKind; rect: Rect; fill: string } | null;
  marquee: Rect | null;
}

/**
 * Canvas 2D drawing in three independent passes so the (expensive) shape pass can be cached
 * in a bitmap layer while the (cheap, fast-changing) background and overlays redraw each frame.
 */
export class CanvasRenderer {
  private readonly lineCache = new Map<string, string[]>();

  drawBackground(ctx: CanvasRenderingContext2D, v: Viewport, dpr: number): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, v.width, v.height);
    let step = 32 * v.scale;
    while (step < 12) step *= 4;
    const startX = -((v.offsetX * v.scale) % step);
    const startY = -((v.offsetY * v.scale) % step);
    ctx.fillStyle = GRID;
    for (let x = startX; x < v.width; x += step) {
      for (let y = startY; y < v.height; y += step) ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }

  /** Draws shapes in the order given. The caller sets a world-space transform first. */
  drawShapes(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    shapes: readonly Shape[],
    scale: number,
    editingId: string | null,
  ): void {
    const lowDetail = scale < LOW_DETAIL_SCALE;
    for (const shape of shapes) this.drawShape(ctx, shape, scale, lowDetail, editingId);
  }

  drawOverlays(ctx: CanvasRenderingContext2D, frame: OverlayModel): void {
    const { viewport: v, dpr } = frame;
    const s = v.scale;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, -v.offsetX * s * dpr, -v.offsetY * s * dpr);

    if (frame.draft) {
      ctx.globalAlpha = 0.6;
      const draft: Shape = {
        ...frame.draft.rect,
        id: '',
        kind: frame.draft.kind,
        fill: frame.draft.fill,
        z: 0,
        text: '',
      };
      this.drawShape(ctx, draft, s, true, null);
      ctx.globalAlpha = 1;
    }

    for (const remote of frame.remotes) {
      ctx.strokeStyle = remote.color;
      ctx.lineWidth = 2 / s;
      ctx.setLineDash([6 / s, 4 / s]);
      for (const shape of remote.selection) outline(ctx, shape, 3 / s);
    }
    ctx.setLineDash([]);

    ctx.strokeStyle = SELECTION;
    ctx.lineWidth = 2 / s;
    for (const shape of frame.selected) outline(ctx, shape, 2 / s);
    if (frame.selectionBounds) {
      ctx.setLineDash([8 / s, 4 / s]);
      outline(ctx, frame.selectionBounds, 4 / s);
      ctx.setLineDash([]);
    }
    const single = frame.selected[0];
    if (frame.showResizeHandle && single) {
      const h = HANDLE_SCREEN_PX / s;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(single.x + single.width - h / 2, single.y + single.height - h / 2, h, h);
      ctx.strokeRect(single.x + single.width - h / 2, single.y + single.height - h / 2, h, h);
    }

    if (frame.marquee) {
      const m = frame.marquee;
      ctx.fillStyle = 'rgba(37, 99, 235, 0.08)';
      ctx.fillRect(m.x, m.y, m.width, m.height);
      ctx.lineWidth = 1 / s;
      ctx.strokeRect(m.x, m.y, m.width, m.height);
    }

    // Cursors are drawn in screen space so they stay the same size at any zoom.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const remote of frame.remotes) {
      if (remote.cursor) drawCursor(ctx, v.worldToScreen(remote.cursor), remote.color, remote.name);
    }
  }

  private drawShape(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    shape: Shape,
    scale: number,
    lowDetail: boolean,
    editingId: string | null,
  ): void {
    ctx.fillStyle = shape.fill;
    const tiny = Math.min(shape.width, shape.height) * scale < MIN_ELLIPSE_SCREEN_PX;
    if (shape.kind === 'ellipse' && !tiny) {
      ctx.beginPath();
      ctx.ellipse(
        shape.x + shape.width / 2,
        shape.y + shape.height / 2,
        shape.width / 2,
        shape.height / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    } else {
      ctx.fillRect(shape.x, shape.y, shape.width, shape.height);
    }
    if (lowDetail || shape.kind !== 'note' || !shape.text || shape.id === editingId) return;

    ctx.font = NOTE_FONT;
    ctx.fillStyle = TEXT;
    ctx.textBaseline = 'top';
    const lines = this.wrap(ctx, shape.text, shape.width - NOTE_PADDING * 2);
    const maxLines = Math.floor((shape.height - NOTE_PADDING * 2) / NOTE_LINE_HEIGHT);
    for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
      ctx.fillText(
        lines[i]!,
        shape.x + NOTE_PADDING,
        shape.y + NOTE_PADDING + i * NOTE_LINE_HEIGHT,
      );
    }
  }

  /** Word-wraps text; measured layouts are cached because measureText is expensive. */
  private wrap(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    text: string,
    maxWidth: number,
  ): string[] {
    const key = `${Math.round(maxWidth)}|${text}`;
    const cached = this.lineCache.get(key);
    if (cached) return cached;

    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const word of paragraph.split(' ')) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(candidate).width > maxWidth) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
    }
    if (this.lineCache.size > TEXT_CACHE_LIMIT) this.lineCache.clear();
    this.lineCache.set(key, lines);
    return lines;
  }
}

function outline(ctx: CanvasRenderingContext2D, r: Rect, pad: number): void {
  ctx.strokeRect(r.x - pad, r.y - pad, r.width + pad * 2, r.height + pad * 2);
}

function drawCursor(ctx: CanvasRenderingContext2D, p: Point, color: string, name: string): void {
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x, p.y + 17);
  ctx.lineTo(p.x + 5, p.y + 13);
  ctx.lineTo(p.x + 12, p.y + 12);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.font = '12px system-ui, -apple-system, sans-serif';
  ctx.textBaseline = 'middle';
  const width = ctx.measureText(name).width + 12;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(p.x + 10, p.y + 18, width, 20, 6);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(name, p.x + 16, p.y + 28);
}
