import { DOC_KEYS, SHAPE_KINDS, type Shape, type ShapeKind } from '@canvas/shared';
import * as Y from 'yjs';
import { applyTextDiff } from './text-diff';

/** Transaction origin for edits made by this user; the undo manager only tracks these. */
export const LOCAL_ORIGIN = 'local-user';

/** Each shape costs ~4 KB of heap in Yjs; far beyond this a browser tab runs out of memory. */
export const MAX_SHAPES_PER_BOARD = 100_000;

export class BoardFullError extends Error {
  constructor() {
    super(`Boards are limited to ${MAX_SHAPES_PER_BOARD.toLocaleString()} shapes`);
  }
}

export type NewShape = Pick<Shape, 'kind' | 'x' | 'y' | 'width' | 'height' | 'fill'> & {
  text?: string;
};
export type ShapePatch = Partial<Pick<Shape, 'x' | 'y' | 'width' | 'height' | 'fill'>>;

export interface ShapeChange {
  upserted: Shape[];
  removed: string[];
}

type YShape = Y.Map<unknown>;

/**
 * Domain API over the shared Y.Doc. Each shape is its own Y.Map, so concurrent edits to
 * different properties (Alice moves, Bob recolors) merge instead of overwriting each other.
 * A plain-object cache is maintained incrementally so the renderer never touches Yjs types.
 */
export class ShapeStore {
  private readonly yShapes: Y.Map<YShape>;
  private readonly cache = new Map<string, Shape>();
  private readonly listeners = new Set<(change: ShapeChange) => void>();
  private sorted: Shape[] | null = null;
  private maxZ = 0;
  private revision = 0;

  constructor(private readonly doc: Y.Doc) {
    this.yShapes = doc.getMap<YShape>(DOC_KEYS.shapes);
    this.yShapes.forEach((yShape, id) => this.cacheShape(id, yShape));
    this.yShapes.observeDeep(this.onChange);
  }

  get size(): number {
    return this.cache.size;
  }

  /** Monotonic counter for React's useSyncExternalStore. */
  getRevision = (): number => this.revision;

  get(id: string): Shape | undefined {
    return this.cache.get(id);
  }

  /** All shapes in paint order (lowest z first). */
  all(): readonly Shape[] {
    this.sorted ??= [...this.cache.values()].sort(byPaintOrder);
    return this.sorted;
  }

  subscribe = (listener: (change: ShapeChange) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  create(input: NewShape): string {
    if (this.cache.size >= MAX_SHAPES_PER_BOARD) throw new BoardFullError();
    const id = crypto.randomUUID();
    this.transact(() => this.insert(id, input, ++this.maxZ));
    return id;
  }

  /** Bulk insert in one transaction (one network message, one undo step). */
  createMany(inputs: NewShape[]): void {
    if (this.cache.size + inputs.length > MAX_SHAPES_PER_BOARD) throw new BoardFullError();
    this.transact(() => {
      for (const input of inputs) this.insert(crypto.randomUUID(), input, ++this.maxZ);
    });
  }

  update(id: string, patch: ShapePatch): void {
    const yShape = this.yShapes.get(id);
    if (!yShape) return;
    this.transact(() => {
      for (const [key, value] of Object.entries(patch)) yShape.set(key, value);
    });
  }

  moveBy(ids: Iterable<string>, dx: number, dy: number): void {
    this.transact(() => {
      for (const id of ids) {
        const yShape = this.yShapes.get(id);
        if (!yShape) continue;
        yShape.set('x', (yShape.get('x') as number) + dx);
        yShape.set('y', (yShape.get('y') as number) + dy);
      }
    });
  }

  setFill(ids: Iterable<string>, fill: string): void {
    this.transact(() => {
      for (const id of ids) this.yShapes.get(id)?.set('fill', fill);
    });
  }

  bringToFront(ids: Iterable<string>): void {
    this.transact(() => {
      for (const id of ids) this.yShapes.get(id)?.set('z', ++this.maxZ);
    });
  }

  setText(id: string, value: string): void {
    const text = this.yShapes.get(id)?.get('text');
    if (!(text instanceof Y.Text)) return;
    this.transact(() => applyTextDiff(text, value));
  }

  remove(ids: Iterable<string>): void {
    this.transact(() => {
      for (const id of ids) this.yShapes.delete(id);
    });
  }

  clear(): void {
    this.transact(() => this.yShapes.clear());
  }

  destroy(): void {
    this.yShapes.unobserveDeep(this.onChange);
    this.listeners.clear();
  }

  private insert(id: string, input: NewShape, z: number): void {
    const yShape = new Y.Map<unknown>();
    yShape.set('kind', input.kind);
    yShape.set('x', input.x);
    yShape.set('y', input.y);
    yShape.set('width', input.width);
    yShape.set('height', input.height);
    yShape.set('fill', input.fill);
    yShape.set('z', z);
    yShape.set('text', new Y.Text(input.text ?? ''));
    this.yShapes.set(id, yShape);
  }

  private transact(fn: () => void): void {
    this.doc.transact(fn, LOCAL_ORIGIN);
  }

  private readonly onChange = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    const touched = new Set<string>();
    for (const event of events) {
      if (event.target === this.yShapes) {
        event.changes.keys.forEach((_change, key) => touched.add(key));
      } else if (typeof event.path[0] === 'string') {
        touched.add(event.path[0]);
      }
    }

    const change: ShapeChange = { upserted: [], removed: [] };
    for (const id of touched) {
      const yShape = this.yShapes.get(id);
      if (yShape) {
        const shape = this.cacheShape(id, yShape);
        if (shape) change.upserted.push(shape);
      } else if (this.cache.delete(id)) {
        change.removed.push(id);
      }
    }
    this.sorted = null;
    this.revision++;
    this.listeners.forEach((listener) => listener(change));
  };

  /** Converts a Y.Map to a plain shape, ignoring malformed entries from buggy/old clients. */
  private cacheShape(id: string, yShape: YShape): Shape | null {
    const kind = yShape.get('kind');
    const text = yShape.get('text');
    const shape: Shape = {
      id,
      kind: kind as ShapeKind,
      x: Number(yShape.get('x')),
      y: Number(yShape.get('y')),
      width: Number(yShape.get('width')),
      height: Number(yShape.get('height')),
      fill: String(yShape.get('fill') ?? '#cccccc'),
      z: Number(yShape.get('z') ?? 0),
      text: text instanceof Y.Text ? text.toString() : '',
    };
    const valid =
      SHAPE_KINDS.includes(shape.kind) &&
      [shape.x, shape.y, shape.width, shape.height, shape.z].every(Number.isFinite);
    if (!valid) {
      this.cache.delete(id);
      return null;
    }
    this.maxZ = Math.max(this.maxZ, shape.z);
    this.cache.set(id, shape);
    return shape;
  }
}

function byPaintOrder(a: Shape, b: Shape): number {
  return a.z - b.z || (a.id < b.id ? -1 : 1);
}
