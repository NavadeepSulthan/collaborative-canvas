import type { Rect } from './geometry';
import type { Viewport } from './viewport';

export type DrawRegion = (
  ctx: OffscreenCanvasRenderingContext2D,
  world: Rect,
  scale: number,
) => number;

interface Camera {
  offsetX: number;
  offsetY: number;
  scale: number;
}

/** Past this many pending dirty regions a single full redraw is cheaper than many clipped ones. */
const MAX_DIRTY_REGIONS = 48;

/**
 * Bitmap cache of the shape pass (double-buffered OffscreenCanvas, viewport-sized).
 *
 * - Pan: shift the previous bitmap by whole device pixels and draw only the exposed strips.
 * - Edit: clear and redraw only the dirty world rects (clipped).
 * - Zoom gesture: show the old bitmap scaled until the gesture settles, then redraw once.
 *
 * Frame cost therefore scales with *what changed*, not with how many shapes are on screen.
 */
export class ShapeLayer {
  private front = new OffscreenCanvas(1, 1);
  private back = new OffscreenCanvas(1, 1);
  private camera: Camera | null = null;
  private dirty: Rect[] = [];

  constructor(private readonly drawRegion: DrawRegion) {}

  resize(width: number, height: number): void {
    this.front = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    this.back = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    this.invalidate();
  }

  invalidate(): void {
    this.camera = null;
    this.dirty = [];
  }

  markDirty(world: Rect): void {
    if (!this.camera) return;
    if (this.dirty.length >= MAX_DIRTY_REGIONS) this.camera = null;
    else this.dirty.push(world);
  }

  /** Brings the cache up to date and composites it. Returns shapes drawn this frame. */
  render(
    target: CanvasRenderingContext2D,
    view: Viewport,
    dpr: number,
    allowStaleZoom: boolean,
  ): { drawn: number; stale: boolean } {
    const camera = this.camera;
    if (camera && camera.scale !== view.scale && allowStaleZoom) {
      this.compositeScaled(target, camera, view, dpr);
      return { drawn: 0, stale: true };
    }

    let drawn = 0;
    if (!camera || camera.scale !== view.scale) {
      drawn = this.renderFull(view, dpr);
    } else {
      drawn += this.shift(camera, view, dpr);
      if (this.camera) {
        const regions = this.dirty;
        this.dirty = [];
        for (const region of regions) drawn += this.renderRegion(this.front, region, dpr);
      } else {
        drawn = this.renderFull(view, dpr);
      }
    }
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.drawImage(this.front, 0, 0);
    return { drawn, stale: false };
  }

  private renderFull(view: Viewport, dpr: number): number {
    this.camera = { offsetX: view.offsetX, offsetY: view.offsetY, scale: view.scale };
    this.dirty = [];
    const ctx = this.front.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.front.width, this.front.height);
    this.applyCamera(ctx, dpr);
    return this.drawRegion(ctx, view.visibleWorldRect(), view.scale);
  }

  /** Moves cached pixels to follow the camera and queues the newly exposed strips. */
  private shift(camera: Camera, view: Viewport, dpr: number): number {
    const k = camera.scale * dpr;
    const dx = Math.round((camera.offsetX - view.offsetX) * k);
    const dy = Math.round((camera.offsetY - view.offsetY) * k);
    if (dx === 0 && dy === 0) return 0;
    const { width, height } = this.front;
    if (Math.abs(dx) >= width || Math.abs(dy) >= height) {
      this.camera = null;
      return 0;
    }

    const ctx = this.back.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.front, dx, dy);
    [this.front, this.back] = [this.back, this.front];
    // Move the cached camera by exactly the whole pixels shifted, so cache and screen stay aligned.
    camera.offsetX -= dx / k;
    camera.offsetY -= dy / k;

    let drawn = 0;
    for (const strip of exposedStrips(dx, dy, width, height)) {
      drawn += this.renderRegion(
        this.front,
        {
          x: camera.offsetX + strip.x / k,
          y: camera.offsetY + strip.y / k,
          width: strip.width / k,
          height: strip.height / k,
        },
        dpr,
      );
    }
    return drawn;
  }

  private renderRegion(canvas: OffscreenCanvas, world: Rect, dpr: number): number {
    const camera = this.camera!;
    const px = worldToDeviceRect(world, camera, dpr, canvas.width, canvas.height);
    if (!px) return 0;
    const ctx = canvas.getContext('2d')!;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(px.x, px.y, px.width, px.height);
    ctx.clip();
    ctx.clearRect(px.x, px.y, px.width, px.height);
    this.applyCamera(ctx, dpr);
    const k = camera.scale * dpr;
    const drawn = this.drawRegion(
      ctx,
      {
        x: camera.offsetX + px.x / k,
        y: camera.offsetY + px.y / k,
        width: px.width / k,
        height: px.height / k,
      },
      camera.scale,
    );
    ctx.restore();
    return drawn;
  }

  private compositeScaled(
    target: CanvasRenderingContext2D,
    camera: Camera,
    view: Viewport,
    dpr: number,
  ): void {
    const ratio = view.scale / camera.scale;
    target.setTransform(
      ratio,
      0,
      0,
      ratio,
      (camera.offsetX - view.offsetX) * view.scale * dpr,
      (camera.offsetY - view.offsetY) * view.scale * dpr,
    );
    target.drawImage(this.front, 0, 0);
    target.setTransform(1, 0, 0, 1, 0, 0);
  }

  private applyCamera(ctx: OffscreenCanvasRenderingContext2D, dpr: number): void {
    const { offsetX, offsetY, scale } = this.camera!;
    const k = scale * dpr;
    ctx.setTransform(k, 0, 0, k, -offsetX * k, -offsetY * k);
  }
}

/** Device-pixel strips uncovered after shifting a width x height bitmap by (dx, dy). */
export function exposedStrips(dx: number, dy: number, width: number, height: number): Rect[] {
  const strips: Rect[] = [];
  if (dx > 0) strips.push({ x: 0, y: 0, width: dx, height });
  if (dx < 0) strips.push({ x: width + dx, y: 0, width: -dx, height });
  const xStart = Math.max(0, dx);
  const xWidth = width - Math.abs(dx);
  if (dy > 0) strips.push({ x: xStart, y: 0, width: xWidth, height: dy });
  if (dy < 0) strips.push({ x: xStart, y: height + dy, width: xWidth, height: -dy });
  return strips;
}

/** World rect -> integer device-pixel rect (rounded outward, clamped), or null if off-canvas. */
export function worldToDeviceRect(
  world: Rect,
  camera: Camera,
  dpr: number,
  width: number,
  height: number,
): Rect | null {
  const k = camera.scale * dpr;
  // One extra pixel covers anti-aliased edges that spill past the exact bounds.
  const x0 = Math.max(0, Math.floor((world.x - camera.offsetX) * k) - 1);
  const y0 = Math.max(0, Math.floor((world.y - camera.offsetY) * k) - 1);
  const x1 = Math.min(width, Math.ceil((world.x + world.width - camera.offsetX) * k) + 1);
  const y1 = Math.min(height, Math.ceil((world.y + world.height - camera.offsetY) * k) + 1);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}
