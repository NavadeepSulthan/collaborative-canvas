import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { compactUpdates } from './compaction.js';
import { decodeEnvelope, encodeEnvelope } from './envelope.js';
import { BackplaneKind } from './ports.js';

function captureUpdates(mutate: (doc: Y.Doc) => void): Uint8Array[] {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => updates.push(u));
  mutate(doc);
  return updates;
}

describe('compactUpdates', () => {
  it('produces a single update equivalent to replaying all deltas', () => {
    const updates = captureUpdates((doc) => {
      const shapes = doc.getMap<number>('shapes');
      for (let i = 0; i < 100; i++) shapes.set(`s${i % 10}`, i);
    });

    const compacted = compactUpdates(updates);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, compacted);

    expect(restored.getMap('shapes').toJSON()).toEqual(
      Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`s${i}`, 90 + i])),
    );
    const totalBytes = updates.reduce((n, u) => n + u.byteLength, 0);
    expect(compacted.byteLength).toBeLessThan(totalBytes);
  });

  it('is idempotent: compacting a snapshot with overlapping deltas changes nothing', () => {
    const updates = captureUpdates((doc) => doc.getText('t').insert(0, 'hello'));
    const once = compactUpdates(updates);
    const twice = compactUpdates([once, ...updates]);
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, once);
    Y.applyUpdate(b, twice);
    expect(b.getText('t').toString()).toBe(a.getText('t').toString());
  });
});

describe('backplane envelope', () => {
  it('round-trips origin, kind and payload', () => {
    const message = {
      origin: 'node-a',
      kind: BackplaneKind.Awareness,
      payload: new Uint8Array([1, 2, 3]),
    };
    expect(decodeEnvelope(encodeEnvelope(message))).toEqual(message);
  });

  it('rejects unknown kinds', () => {
    const bad = encodeEnvelope({
      origin: 'x',
      kind: 9 as BackplaneKind,
      payload: new Uint8Array(),
    });
    expect(() => decodeEnvelope(bad)).toThrow(/Unknown backplane message kind/);
  });
});
