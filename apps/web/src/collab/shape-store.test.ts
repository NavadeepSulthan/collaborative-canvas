import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { BoardFullError, MAX_SHAPES_PER_BOARD, ShapeStore } from './shape-store';
import { diffText } from './text-diff';

/** Two replicas that exchange updates directly, like two browsers behind a server. */
function replicas() {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  docA.on(
    'update',
    (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(docB, u, 'remote'),
  );
  docB.on(
    'update',
    (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(docA, u, 'remote'),
  );
  return { a: new ShapeStore(docA), b: new ShapeStore(docB) };
}

const rect = { kind: 'rect' as const, x: 0, y: 0, width: 100, height: 50, fill: '#fff' };

describe('ShapeStore', () => {
  it('replicates creates, updates and deletes', () => {
    const { a, b } = replicas();
    const id = a.create(rect);
    expect(b.get(id)).toMatchObject({ kind: 'rect', width: 100 });

    b.update(id, { width: 300 });
    expect(a.get(id)?.width).toBe(300);

    a.remove([id]);
    expect(b.size).toBe(0);
  });

  it('merges concurrent edits to different properties of the same shape', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = new ShapeStore(docA);
    const id = a.create(rect);
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const b = new ShapeStore(docB);

    // Both edit while "offline", then exchange state.
    a.moveBy([id], 10, 20);
    b.setFill([id], '#f00');
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));

    expect(a.get(id)).toMatchObject({ x: 10, y: 20, fill: '#f00' });
    expect(b.get(id)).toEqual(a.get(id));
  });

  it('merges concurrent typing in the same note', () => {
    const docA = new Y.Doc();
    const a = new ShapeStore(docA);
    const id = a.create({ ...rect, kind: 'note', text: 'hello world' });
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const b = new ShapeStore(docB);

    a.setText(id, 'hello brave world');
    b.setText(id, 'hello world!');
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));

    expect(a.get(id)?.text).toBe('hello brave world!');
    expect(b.get(id)?.text).toBe('hello brave world!');
  });

  it('keeps paint order by z and brings shapes to front', () => {
    const { a } = replicas();
    const first = a.create(rect);
    const second = a.create(rect);
    expect(a.all().map((s) => s.id)).toEqual([first, second]);
    a.bringToFront([first]);
    expect(a.all().map((s) => s.id)).toEqual([second, first]);
  });

  it('notifies subscribers with upserted and removed ids', () => {
    const { a, b } = replicas();
    const listener = vi.fn();
    b.subscribe(listener);
    const id = a.create(rect);
    a.remove([id]);
    expect(listener.mock.calls.map(([change]) => change)).toEqual([
      { upserted: [expect.objectContaining({ id })], removed: [] },
      { upserted: [], removed: [id] },
    ]);
  });

  it('ignores malformed shapes written by other clients', () => {
    const doc = new Y.Doc();
    const bad = new Y.Map<unknown>();
    bad.set('kind', 'triangle');
    doc.getMap('shapes').set('bad', bad);
    expect(new ShapeStore(doc).size).toBe(0);
  });

  it('refuses bulk inserts that would exceed the per-board limit, without partial writes', () => {
    const store = new ShapeStore(new Y.Doc());
    const tooMany = Array.from({ length: MAX_SHAPES_PER_BOARD + 1 }, () => rect);
    expect(() => store.createMany(tooMany)).toThrow(BoardFullError);
    expect(store.size).toBe(0);
  });
});

describe('diffText', () => {
  it.each([
    ['abc', 'abc', null],
    ['', 'hi', { index: 0, deleteCount: 0, insert: 'hi' }],
    ['hello', 'help', { index: 3, deleteCount: 2, insert: 'p' }],
    ['hello world', 'hello brave world', { index: 6, deleteCount: 0, insert: 'brave ' }],
    ['aaa', 'aa', { index: 2, deleteCount: 1, insert: '' }],
  ])('%j -> %j', (prev, next, expected) => {
    expect(diffText(prev, next)).toEqual(expected);
  });
});
