import { MessageType } from '@canvas/shared';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type { ClientSpec, RoomState } from './messages.js';

const LOCAL = 'local';
const REMOTE = 'remote';
const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];
const FILLS = ['#fde68a', '#bfdbfe', '#bbf7d0', '#fecaca', '#ddd6fe'];

/** Wall-clock milliseconds with sub-ms precision, comparable across worker threads. */
export const nowMs = (): number => performance.timeOrigin + performance.now();

/**
 * One simulated user speaking the real y-websocket protocol.
 *
 * - `editor`: makes edits on its own shapes and receives the full fan-out, but only counts
 *   incoming bytes instead of integrating them (that CPU cost belongs to each user's own
 *   browser, not the server under test).
 * - `observer`: integrates everything like a real browser, measures edit-to-screen latency
 *   from the timestamp embedded in each edit, and reports its final state for convergence.
 */
export class SimClient {
  readonly doc = new Y.Doc();
  readonly latenciesMs: number[] = [];
  readonly stats = { framesIn: 0, bytesIn: 0, framesOut: 0, bytesOut: 0, disconnects: 0 };
  private readonly shapes = this.doc.getMap<Y.Map<unknown>>('shapes');
  private readonly awareness: awarenessProtocol.Awareness | null;
  private readonly own: Y.Map<unknown>[] = [];
  private readonly ownNotes: Y.Map<unknown>[] = [];
  private ws: WebSocket | null = null;
  private onSynced: (() => void) | null = null;
  private measureFrom = Infinity;

  constructor(
    readonly spec: ClientSpec,
    private readonly wsUrl: string,
    private readonly token: string,
  ) {
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL)
        this.send(frame(MessageType.Sync, (e) => syncProtocol.writeUpdate(e, update)));
    });
    if (spec.role === 'observer') {
      this.awareness = null;
      this.shapes.observeDeep(this.measure);
    } else {
      this.awareness = new awarenessProtocol.Awareness(this.doc);
      this.awareness.on(
        'update',
        ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
          if (origin !== 'local' || !this.awareness) return;
          const changed = [...added!, ...updated!, ...removed!];
          const payload = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
          this.send(frame(MessageType.Awareness, (e) => encoding.writeVarUint8Array(e, payload)));
        },
      );
    }
  }

  /** Resolves once the initial state exchange with the server has completed. */
  connect(timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`client ${this.spec.index} sync timeout`)),
        timeoutMs,
      );
      this.onSynced = () => {
        clearTimeout(timer);
        resolve();
      };
      const ws = new WebSocket(`${this.wsUrl}/${this.spec.room}?token=${this.token}`);
      this.ws = ws;
      ws.binaryType = 'nodebuffer';
      ws.on('open', () => {
        this.send(frame(MessageType.Sync, (e) => syncProtocol.writeSyncStep1(e, this.doc)));
        this.awareness?.setLocalState({
          user: {
            id: `bot-${this.spec.index}`,
            name: `Bot ${this.spec.index}`,
            color: COLORS[this.spec.index % COLORS.length],
          },
          cursor: null,
          selection: [],
        });
      });
      ws.on('message', this.onMessage);
      ws.on('close', (code) => {
        if (code !== 1000) this.stats.disconnects++;
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  startMeasuring(from: number): void {
    this.measureFrom = from;
  }

  /** One user action: create a shape, move one, or type into a note. */
  edit(): void {
    const t = nowMs();
    const roll = Math.random();
    this.doc.transact(() => {
      if (this.own.length === 0 || roll < 0.2) this.create(t);
      else if (roll < 0.9 || this.ownNotes.length === 0) this.move(pick(this.own), t);
      else this.type(pick(this.ownNotes), t);
    }, LOCAL);
  }

  moveCursor(): void {
    this.awareness?.setLocalStateField('cursor', {
      x: Math.random() * 4000,
      y: Math.random() * 3000,
    });
  }

  ownState(): RoomState {
    return Object.fromEntries(
      this.own.map((shape) => [shape.get('id') as string, canonical(shape.toJSON())]),
    );
  }

  get shapeCount(): number {
    return this.shapes.size;
  }

  fullState(): RoomState {
    const state: RoomState = {};
    this.shapes.forEach((shape, id) => (state[id] = canonical(shape.toJSON())));
    return state;
  }

  close(): void {
    this.awareness?.destroy();
    this.ws?.close(1000);
    this.doc.destroy();
  }

  private create(t: number): void {
    const n = this.own.length;
    const id = `u${this.spec.index}-s${n}`;
    const kind = n % 3 === 0 ? 'note' : n % 3 === 1 ? 'rect' : 'ellipse';
    const shape = new Y.Map<unknown>();
    shape.set('id', id);
    shape.set('kind', kind);
    shape.set('x', Math.round(Math.random() * 4000));
    shape.set('y', Math.round(Math.random() * 3000));
    shape.set('width', 60 + Math.round(Math.random() * 120));
    shape.set('height', 60 + Math.round(Math.random() * 80));
    shape.set('fill', FILLS[this.spec.index % FILLS.length]);
    shape.set('z', this.spec.index * 1000 + n);
    shape.set('text', new Y.Text(kind === 'note' ? `note by bot ${this.spec.index}` : ''));
    shape.set('t', t);
    this.shapes.set(id, shape);
    this.own.push(shape);
    if (kind === 'note') this.ownNotes.push(shape);
  }

  private move(shape: Y.Map<unknown>, t: number): void {
    shape.set('x', (shape.get('x') as number) + Math.round(Math.random() * 20 - 10));
    shape.set('y', (shape.get('y') as number) + Math.round(Math.random() * 20 - 10));
    shape.set('t', t);
  }

  private type(shape: Y.Map<unknown>, t: number): void {
    const text = shape.get('text') as Y.Text;
    text.insert(text.length, String.fromCharCode(97 + Math.floor(Math.random() * 26)));
    shape.set('t', t);
  }

  private readonly onMessage = (data: Buffer): void => {
    this.stats.framesIn++;
    this.stats.bytesIn += data.byteLength;
    const decoder = decoding.createDecoder(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
    if (decoding.readVarUint(decoder) !== MessageType.Sync) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Sync);
    let syncType: number;
    if (this.spec.role === 'observer') {
      syncType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, REMOTE);
    } else {
      syncType = decoding.readVarUint(decoder);
      if (syncType === syncProtocol.messageYjsSyncStep1)
        syncProtocol.readSyncStep1(decoder, encoder, this.doc);
    }
    if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));
    if (syncType === syncProtocol.messageYjsSyncStep2 && this.onSynced) {
      this.onSynced();
      this.onSynced = null;
    }
  };

  /** Records now - t for every shape whose `t` changed in a remote transaction. */
  private readonly measure = (
    events: Y.YEvent<Y.AbstractType<unknown>>[],
    txn: Y.Transaction,
  ): void => {
    if (txn.origin !== REMOTE) return;
    const now = nowMs();
    const seen = new Set<Y.Map<unknown>>();
    for (const event of events) {
      if (event.target === this.shapes) {
        event.changes.keys.forEach((change, key) => {
          const shape = this.shapes.get(key);
          if (change.action !== 'delete' && shape) seen.add(shape);
        });
      } else if (
        event.target instanceof Y.Map &&
        (event as Y.YMapEvent<unknown>).keysChanged.has('t')
      ) {
        seen.add(event.target as Y.Map<unknown>);
      }
    }
    for (const shape of seen) {
      const t = shape.get('t') as number;
      if (t >= this.measureFrom) this.latenciesMs.push(now - t);
    }
  };

  private send(message: Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.stats.framesOut++;
    this.stats.bytesOut += message.byteLength;
    this.ws.send(message);
  }
}

function frame(type: number, write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
  );
}
