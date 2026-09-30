import type { Point, Shape, ShapeKind } from '@canvas/shared';
import type { PresenceController } from '../collab/presence';
import { BoardFullError, type ShapeChange, type ShapeStore } from '../collab/shape-store';
import { CursorInterpolator } from './cursor-interpolator';
import { FrameStats, type FrameStatsSnapshot } from './frame-stats';
import {
  boundsOf,
  intersects,
  rectContains,
  rectFromPoints,
  shapeContains,
  type Rect,
} from './geometry';
import {
  CanvasRenderer,
  HANDLE_SCREEN_PX,
  MAX_OUTLINED_SELECTION,
  type RemoteOverlay,
} from './renderer';
import { ShapeLayer } from './shape-layer';
import { SpatialHash } from './spatial-index';
import { Viewport } from './viewport';

export type Tool = 'select' | 'rect' | 'ellipse' | 'note' | 'pan';

const DRAW_TOOLS: ReadonlySet<Tool> = new Set(['rect', 'ellipse', 'note']);
const DEFAULT_SIZE: Record<ShapeKind, { width: number; height: number }> = {
  rect: { width: 160, height: 100 },
  ellipse: { width: 140, height: 140 },
  note: { width: 200, height: 160 },
};
const MIN_SIZE = 8;
/** A zoom gesture is considered finished after this long without wheel events. */
const ZOOM_SETTLE_MS = 120;

type Interaction =
  | { type: 'idle' }
  | { type: 'pan'; last: Point }
  | { type: 'move'; last: Point }
  | { type: 'resize'; id: string; origin: Rect; start: Point }
  | { type: 'draw'; kind: ShapeKind; start: Point; current: Point }
  | { type: 'marquee'; start: Point; current: Point; base: Set<string> };

export interface CanvasEngineOptions {
  readOnly: boolean;
  getFill(): string;
  onSelectionChange(ids: string[]): void;
  onToolChange(tool: Tool): void;
  onEditNote(id: string): void;
  onError(message: string): void;
}

/**
 * Framework-agnostic canvas controller: owns the camera, spatial index, input state machine
 * and an on-demand requestAnimationFrame loop (frames are drawn only when something changed
 * or a remote cursor is still gliding, so an idle board costs ~0% CPU). Shapes are cached in
 * a ShapeLayer bitmap, so a frame's cost is proportional to what changed, not to board size.
 */
export class CanvasEngine {
  readonly viewport = new Viewport();
  private readonly ctx: CanvasRenderingContext2D;
  private readonly index = new SpatialHash();
  private readonly cursors = new CursorInterpolator();
  private readonly renderer = new CanvasRenderer();
  private readonly layer = new ShapeLayer((ctx, world, scale) =>
    this.drawRegion(ctx, world, scale),
  );
  private readonly stats = new FrameStats();
  private readonly viewportListeners = new Set<() => void>();
  private readonly disposers: (() => void)[] = [];
  private selection = new Set<string>();
  private selectionBounds: Rect | null = null;
  private selectionBoundsStale = false;
  private tool: Tool = 'select';
  private spacePan = false;
  private interaction: Interaction = { type: 'idle' };
  private editingId: string | null = null;
  private dpr = 1;
  private frameHandle: number | null = null;
  private lastFrameAt = 0;
  private zoomSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private benchmark: {
    start: number;
    until: number;
    origin: Point;
    done(s: FrameStatsSnapshot): void;
  } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly store: ShapeStore,
    private readonly presence: PresenceController,
    private readonly options: CanvasEngineOptions,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not supported');
    this.ctx = ctx;

    for (const shape of store.all()) this.index.upsert(shape.id, shape);
    this.disposers.push(store.subscribe(this.onShapesChanged));
    this.disposers.push(presence.subscribe(this.onPresenceChanged));
    this.listen(canvas, 'pointerdown', this.onPointerDown);
    this.listen(canvas, 'pointermove', this.onPointerMove);
    this.listen(canvas, 'pointerup', this.onPointerUp);
    this.listen(canvas, 'pointercancel', this.onPointerUp);
    this.listen(canvas, 'pointerleave', () => presence.setCursor(null));
    this.listen(canvas, 'dblclick', this.onDoubleClick);
    this.listen(canvas, 'wheel', this.onWheel, { passive: false });
    this.listen(canvas, 'contextmenu', (e) => e.preventDefault());

    const resizeObserver = new ResizeObserver(() => this.resize());
    resizeObserver.observe(canvas);
    this.disposers.push(() => resizeObserver.disconnect());
    this.resize();
  }

  // ---- Public API -------------------------------------------------------

  getTool(): Tool {
    return this.tool;
  }

  setTool(tool: Tool): void {
    if (this.options.readOnly && DRAW_TOOLS.has(tool)) return;
    this.tool = tool;
    this.updateCursorStyle();
    this.options.onToolChange(tool);
  }

  setSpacePan(active: boolean): void {
    this.spacePan = active;
    this.updateCursorStyle();
  }

  getSelection(): string[] {
    return [...this.selection];
  }

  setSelection(ids: Iterable<string>): void {
    this.selection = new Set(ids);
    this.selectionBoundsStale = true;
    const list = [...this.selection];
    this.presence.setSelection(list);
    this.options.onSelectionChange(list);
    this.invalidate();
  }

  selectAll(): void {
    this.setSelection(this.store.all().map((s) => s.id));
  }

  deleteSelection(): void {
    if (this.options.readOnly || this.selection.size === 0) return;
    this.store.remove(this.selection);
    this.setSelection([]);
  }

  setEditing(id: string | null): void {
    // The note being edited hides its canvas text under the textarea, so repaint both notes.
    for (const noteId of [this.editingId, id]) {
      const shape = noteId ? this.store.get(noteId) : undefined;
      if (shape) this.layer.markDirty(shape);
    }
    this.editingId = id;
    this.invalidate();
  }

  zoomBy(factor: number): void {
    this.viewport.zoomAt({ x: this.viewport.width / 2, y: this.viewport.height / 2 }, factor);
    this.viewportChanged();
  }

  zoomToFit(): void {
    const bounds = boundsOf(this.store.all());
    if (!bounds) return;
    const padding = 80;
    const scale = Math.min(
      (this.viewport.width - padding) / Math.max(bounds.width, 1),
      (this.viewport.height - padding) / Math.max(bounds.height, 1),
      2,
    );
    this.viewport.scale = Math.max(scale, 0.05);
    this.viewport.offsetX =
      bounds.x + bounds.width / 2 - this.viewport.width / 2 / this.viewport.scale;
    this.viewport.offsetY =
      bounds.y + bounds.height / 2 - this.viewport.height / 2 / this.viewport.scale;
    this.viewportChanged();
  }

  visibleWorldRect(): Rect {
    return this.viewport.visibleWorldRect();
  }

  screenRectOf(id: string): Rect | null {
    const shape = this.store.get(id);
    return shape ? this.viewport.worldRectToScreen(shape) : null;
  }

  subscribeViewport(listener: () => void): () => void {
    this.viewportListeners.add(listener);
    return () => this.viewportListeners.delete(listener);
  }

  getStats(): FrameStatsSnapshot {
    return this.stats.snapshot();
  }

  /** Pans continuously for `durationMs`, forcing a frame every vsync, and reports timings. */
  runBenchmark(durationMs = 3000): Promise<FrameStatsSnapshot> {
    this.stats.reset();
    return new Promise((resolve) => {
      const start = performance.now();
      this.benchmark = {
        start,
        until: start + durationMs,
        origin: { x: this.viewport.offsetX, y: this.viewport.offsetY },
        done: resolve,
      };
      this.invalidate();
    });
  }

  destroy(): void {
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    if (this.zoomSettleTimer) clearTimeout(this.zoomSettleTimer);
    this.disposers.forEach((dispose) => dispose());
    this.viewportListeners.clear();
  }

  // ---- Frame loop -------------------------------------------------------

  private invalidate(): void {
    this.frameHandle ??= requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number): void => {
    this.frameHandle = null;
    const dt = this.lastFrameAt ? now - this.lastFrameAt : 16;
    this.lastFrameAt = now;

    let animating = this.cursors.step(dt);
    if (this.benchmark) animating = this.advanceBenchmark(now) || animating;

    const started = performance.now();
    const drawn = this.draw();
    this.stats.record(now, performance.now() - started, drawn);

    if (animating) {
      this.invalidate();
    } else {
      this.lastFrameAt = 0;
      this.stats.pause();
    }
  };

  private advanceBenchmark(now: number): boolean {
    const bench = this.benchmark!;
    const t = (now - bench.start) / 1000;
    this.viewport.offsetX = bench.origin.x + Math.sin(t * 2) * 400;
    this.viewport.offsetY = bench.origin.y + Math.cos(t * 2) * 300;
    if (now < bench.until) return true;
    this.viewport.offsetX = bench.origin.x;
    this.viewport.offsetY = bench.origin.y;
    this.benchmark = null;
    bench.done(this.stats.snapshot());
    return false;
  }

  private draw(): number {
    this.renderer.drawBackground(this.ctx, this.viewport, this.dpr);
    const { drawn } = this.layer.render(
      this.ctx,
      this.viewport,
      this.dpr,
      this.zoomSettleTimer !== null,
    );

    const interaction = this.interaction;
    const outlineEach = this.selection.size <= MAX_OUTLINED_SELECTION;
    const selected = outlineEach
      ? [...this.selection].map((id) => this.store.get(id)).filter(isDefined)
      : [];
    this.renderer.drawOverlays(this.ctx, {
      viewport: this.viewport,
      dpr: this.dpr,
      selected,
      selectionBounds: outlineEach ? null : this.currentSelectionBounds(),
      showResizeHandle: !this.options.readOnly && selected.length === 1,
      remotes: this.remoteOverlays(),
      draft:
        interaction.type === 'draw'
          ? {
              kind: interaction.kind,
              rect: rectFromPoints(interaction.start, interaction.current),
              fill: this.options.getFill(),
            }
          : null,
      marquee:
        interaction.type === 'marquee'
          ? rectFromPoints(interaction.start, interaction.current)
          : null,
    });
    return drawn;
  }

  /** Paints every shape intersecting `world` in z-order; used by the layer for full and partial redraws. */
  private drawRegion(ctx: OffscreenCanvasRenderingContext2D, world: Rect, scale: number): number {
    const shapes: Shape[] = [];
    for (const id of this.index.query(world)) {
      const shape = this.store.get(id);
      if (shape && intersects(shape, world)) shapes.push(shape);
    }
    shapes.sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1));
    this.renderer.drawShapes(ctx, shapes, scale, this.editingId);
    return shapes.length;
  }

  private currentSelectionBounds(): Rect | null {
    if (this.selectionBoundsStale) {
      this.selectionBounds = boundsOf(
        [...this.selection].map((id) => this.store.get(id)).filter(isDefined),
      );
      this.selectionBoundsStale = false;
    }
    return this.selectionBounds;
  }

  private remoteOverlays(): RemoteOverlay[] {
    return this.presence.getPeers().map((peer) => ({
      name: peer.user.name,
      color: peer.user.color,
      cursor: peer.cursor ? (this.cursors.get(peer.clientId) ?? peer.cursor) : null,
      selection: peer.selection.map((id) => this.store.get(id)).filter(isDefined),
    }));
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.layer.resize(this.canvas.width, this.canvas.height);
    this.viewport.resize(rect.width, rect.height);
    this.viewportChanged();
  }

  private viewportChanged(): void {
    this.viewportListeners.forEach((listener) => listener());
    this.invalidate();
  }

  // ---- Model subscriptions ---------------------------------------------

  private readonly onShapesChanged = (change: ShapeChange): void => {
    const visible = this.viewport.visibleWorldRect();
    const repaint = (rect: Rect | undefined) => {
      if (rect && intersects(rect, visible)) this.layer.markDirty(rect);
    };
    for (const shape of change.upserted) {
      repaint(this.index.boundsOf(shape.id));
      repaint(shape);
      this.index.upsert(shape.id, shape);
      if (this.selection.has(shape.id)) this.selectionBoundsStale = true;
    }
    let selectionChanged = false;
    for (const id of change.removed) {
      repaint(this.index.boundsOf(id));
      this.index.remove(id);
      selectionChanged = this.selection.delete(id) || selectionChanged;
    }
    if (selectionChanged) this.setSelection(this.selection);
    if (this.editingId && !this.store.get(this.editingId)) this.editingId = null;
    this.viewportListeners.forEach((listener) => listener());
    this.invalidate();
  };

  private readonly onPresenceChanged = (): void => {
    const withCursor = new Set<number>();
    for (const peer of this.presence.getPeers()) {
      if (!peer.cursor) continue;
      withCursor.add(peer.clientId);
      this.cursors.setTarget(peer.clientId, peer.cursor);
    }
    this.cursors.retainOnly(withCursor);
    this.invalidate();
  };

  // ---- Input ------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    const screen = this.localPoint(e);
    const world = this.viewport.screenToWorld(screen);

    if (e.button === 1 || this.tool === 'pan' || this.spacePan) {
      this.interaction = { type: 'pan', last: screen };
      return;
    }
    if (e.button !== 0) return;

    if (DRAW_TOOLS.has(this.tool) && !this.options.readOnly) {
      this.interaction = {
        type: 'draw',
        kind: this.tool as ShapeKind,
        start: world,
        current: world,
      };
      return;
    }

    const handleTarget = this.resizeHandleAt(world);
    if (handleTarget) {
      this.interaction = {
        type: 'resize',
        id: handleTarget.id,
        origin: { ...handleTarget },
        start: world,
      };
      return;
    }

    const hit = this.hitTest(world);
    if (hit) {
      if (e.shiftKey) {
        const next = new Set(this.selection);
        if (!next.delete(hit)) next.add(hit);
        this.setSelection(next);
      } else if (!this.selection.has(hit)) {
        this.setSelection([hit]);
      }
      if (!this.options.readOnly) this.interaction = { type: 'move', last: world };
    } else {
      const base = e.shiftKey ? new Set(this.selection) : new Set<string>();
      if (!e.shiftKey) this.setSelection([]);
      this.interaction = { type: 'marquee', start: world, current: world, base };
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const screen = this.localPoint(e);
    const world = this.viewport.screenToWorld(screen);
    this.presence.setCursor(world);
    const interaction = this.interaction;

    switch (interaction.type) {
      case 'pan':
        this.viewport.panByScreen(screen.x - interaction.last.x, screen.y - interaction.last.y);
        interaction.last = screen;
        this.viewportChanged();
        break;
      case 'move':
        this.store.moveBy(
          this.selection,
          world.x - interaction.last.x,
          world.y - interaction.last.y,
        );
        interaction.last = world;
        break;
      case 'resize':
        this.store.update(interaction.id, {
          width: Math.max(MIN_SIZE, interaction.origin.width + world.x - interaction.start.x),
          height: Math.max(MIN_SIZE, interaction.origin.height + world.y - interaction.start.y),
        });
        break;
      case 'draw':
        interaction.current = world;
        this.invalidate();
        break;
      case 'marquee':
        // Selection is resolved once on release; hit-testing thousands of shapes per move is wasted work.
        interaction.current = world;
        this.invalidate();
        break;
      case 'idle':
        this.updateHoverCursor(world);
        break;
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const interaction = this.interaction;
    this.interaction = { type: 'idle' };

    if (interaction.type === 'marquee') {
      const area = rectFromPoints(interaction.start, interaction.current);
      const hits = [...this.index.query(area)].filter((id) => {
        const shape = this.store.get(id);
        return shape && intersects(shape, area);
      });
      this.setSelection([...interaction.base, ...hits]);
    }
    if (interaction.type === 'draw') {
      let rect = rectFromPoints(interaction.start, interaction.current);
      if (rect.width < MIN_SIZE && rect.height < MIN_SIZE) {
        const size = DEFAULT_SIZE[interaction.kind];
        rect = {
          x: interaction.start.x - size.width / 2,
          y: interaction.start.y - size.height / 2,
          ...size,
        };
      }
      let id: string;
      try {
        id = this.store.create({
          kind: interaction.kind,
          ...rect,
          fill: this.options.getFill(),
        });
      } catch (error) {
        if (!(error instanceof BoardFullError)) throw error;
        this.options.onError(error.message);
        this.invalidate();
        return;
      }
      this.setSelection([id]);
      this.setTool('select');
      if (interaction.kind === 'note') this.options.onEditNote(id);
    }
    this.invalidate();
  };

  private readonly onDoubleClick = (e: MouseEvent): void => {
    if (this.options.readOnly) return;
    const hit = this.hitTest(this.viewport.screenToWorld(this.localPoint(e)));
    if (hit && this.store.get(hit)?.kind === 'note') this.options.onEditNote(hit);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      this.viewport.zoomAt(this.localPoint(e), Math.exp(-e.deltaY * 0.01));
      // Show the cached bitmap scaled while the gesture continues; re-render crisply once it settles.
      if (this.zoomSettleTimer) clearTimeout(this.zoomSettleTimer);
      this.zoomSettleTimer = setTimeout(() => {
        this.zoomSettleTimer = null;
        this.invalidate();
      }, ZOOM_SETTLE_MS);
    } else {
      this.viewport.panByScreen(-e.deltaX, -e.deltaY);
    }
    this.viewportChanged();
  };

  private hitTest(world: Point): string | null {
    let best: Shape | null = null;
    for (const id of this.index.queryPoint(world)) {
      const shape = this.store.get(id);
      if (shape && shapeContains(shape, world) && (!best || shape.z > best.z)) best = shape;
    }
    return best?.id ?? null;
  }

  private resizeHandleAt(world: Point): Shape | null {
    if (this.options.readOnly || this.selection.size !== 1) return null;
    const shape = this.store.get(this.selection.values().next().value!);
    if (!shape) return null;
    const h = HANDLE_SCREEN_PX / this.viewport.scale;
    const handle = {
      x: shape.x + shape.width - h,
      y: shape.y + shape.height - h,
      width: h * 2,
      height: h * 2,
    };
    return rectContains(handle, world) ? shape : null;
  }

  private updateHoverCursor(world: Point): void {
    if (this.tool !== 'select' || this.spacePan) return;
    this.canvas.style.cursor = this.resizeHandleAt(world)
      ? 'nwse-resize'
      : this.hitTest(world)
        ? 'move'
        : 'default';
  }

  private updateCursorStyle(): void {
    this.canvas.style.cursor =
      this.tool === 'pan' || this.spacePan
        ? 'grab'
        : DRAW_TOOLS.has(this.tool)
          ? 'crosshair'
          : 'default';
  }

  private localPoint(e: MouseEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler, options);
    this.disposers.push(() => target.removeEventListener(type, handler, options));
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
