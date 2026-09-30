import { CloseCode, MessageType } from '@canvas/shared';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { MemoryBackplane } from '../infrastructure/memory/memory-backplane.js';
import { MemoryDocumentStore } from '../infrastructure/memory/memory-document-store.js';
import { BackplaneKind, type BackplaneMessage } from './ports.js';
import {
  closeCodeFor,
  connectClient,
  issueToken,
  startTestNode,
  waitFor,
  type TestClient,
  type TestNode,
} from '../testing/harness.js';

/**
 * Two server nodes share one backplane + store, exactly like two replicas behind a
 * load balancer sharing Redis and Postgres.
 */
describe('collaboration across nodes', () => {
  let backplane: MemoryBackplane;
  let store: MemoryDocumentStore;
  let nodeA: TestNode;
  let nodeB: TestNode;
  const clients: TestClient[] = [];

  const connect = (node: TestNode, room: string, token: string) => {
    const client = connectClient(node.wsUrl, room, token);
    clients.push(client);
    return client;
  };

  beforeEach(async () => {
    backplane = new MemoryBackplane();
    store = new MemoryDocumentStore();
    nodeA = await startTestNode({ nodeId: 'node-a', backplane, store });
    nodeB = await startTestNode({ nodeId: 'node-b', backplane, store });
  });

  afterEach(async () => {
    clients.splice(0).forEach((c) => c.destroy());
    await Promise.all([nodeA.close(), nodeB.close()]);
  });

  it('converges edits made on different nodes', async () => {
    const token = await issueToken('acme');
    const alice = connect(nodeA, 'board', token);
    const bob = connect(nodeB, 'board', token);
    await waitFor(() => alice.provider.synced && bob.provider.synced);

    alice.doc.getMap('shapes').set('a', 1);
    bob.doc.getMap('shapes').set('b', 2);

    await waitFor(
      () => alice.doc.getMap('shapes').size === 2 && bob.doc.getMap('shapes').size === 2,
    );
    expect(alice.doc.getMap('shapes').toJSON()).toEqual(bob.doc.getMap('shapes').toJSON());
  });

  it('relays presence (awareness) across nodes and clears it on disconnect', async () => {
    const token = await issueToken('acme');
    const alice = connect(nodeA, 'board', token);
    const bob = connect(nodeB, 'board', token);
    await waitFor(() => alice.provider.wsconnected && bob.provider.wsconnected);

    alice.provider.awareness.setLocalStateField('user', { name: 'Alice' });
    const aliceId = alice.doc.clientID;
    await waitFor(() => bob.provider.awareness.getStates().has(aliceId));

    alice.destroy();
    await waitFor(() => !bob.provider.awareness.getStates().has(aliceId));
  });

  it('persists edits, compacts on eviction, and restores for new sessions', async () => {
    const token = await issueToken('acme');
    const writer = connect(nodeA, 'persisted', token);
    await waitFor(() => writer.provider.synced);
    for (let i = 0; i < 20; i++) writer.doc.getMap('shapes').set(`s${i}`, i);
    await waitFor(() => store.pendingUpdates('acme/persisted') > 0);

    writer.destroy();
    await waitFor(() => nodeA.app.rooms.size === 0);
    expect(store.pendingUpdates('acme/persisted')).toBe(0);

    const reader = connect(nodeB, 'persisted', token);
    await waitFor(() => reader.provider.synced && reader.doc.getMap('shapes').size === 20);
  });

  it('isolates tenants that use the same room id', async () => {
    const acme = connect(nodeA, 'shared-name', await issueToken('acme'));
    const globex = connect(nodeA, 'shared-name', await issueToken('globex'));
    await waitFor(() => acme.provider.synced && globex.provider.synced);

    acme.doc.getMap('shapes').set('secret', 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(globex.doc.getMap('shapes').size).toBe(0);
  });

  it('drops writes from viewers but still sends them state', async () => {
    const editor = connect(nodeA, 'readonly', await issueToken('acme', 'editor'));
    const viewer = connect(nodeB, 'readonly', await issueToken('acme', 'viewer'));
    await waitFor(() => editor.provider.synced && viewer.provider.synced);

    viewer.doc.getMap('shapes').set('vandal', 1);
    editor.doc.getMap('shapes').set('legit', 1);

    await waitFor(() => viewer.doc.getMap('shapes').has('legit'));
    await new Promise((r) => setTimeout(r, 100));
    expect(editor.doc.getMap('shapes').has('vandal')).toBe(false);
  });

  it('echoes awareness to the sender so solo clients see traffic (y-websocket 30s liveness check)', async () => {
    const token = await issueToken('acme');
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState({ user: 'solo' });
    const ws = new WebSocket(`${nodeA.wsUrl}/solo?token=${token}`);
    const received: number[] = [];
    ws.on('message', (data: Buffer) =>
      received.push(decoding.readVarUint(decoding.createDecoder(data))),
    );
    await new Promise((resolve) => ws.once('open', resolve));

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Awareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]),
    );
    ws.send(encoding.toUint8Array(encoder));

    await waitFor(() => received.includes(MessageType.Awareness));
    ws.close();
    awareness.destroy();
  });

  it('closes only the sender of a malformed update, keeping batched edits from others', async () => {
    const token = await issueToken('acme');
    const good = connect(nodeA, 'mixed', token);
    await waitFor(() => good.provider.synced);
    const bad = new WebSocket(`${nodeA.wsUrl}/mixed?token=${token}`);
    await new Promise((resolve) => bad.once('open', resolve));
    const closed = new Promise<number>((resolve) => bad.once('close', resolve));

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Sync);
    encoding.writeVarUint(encoder, 2);
    encoding.writeVarUint8Array(encoder, new Uint8Array([1, 1, 5, 0, 9, 9]));
    bad.send(encoding.toUint8Array(encoder));
    good.doc.getMap('shapes').set('kept', 1);

    expect(await closed).toBe(CloseCode.BadRequest);
    const reader = connect(nodeB, 'mixed', token);
    await waitFor(() => reader.provider.synced && reader.doc.getMap('shapes').has('kept'));
    expect(good.provider.wsconnected).toBe(true);
  });

  it('rejects sockets without a valid token or with a bad room id', async () => {
    expect(await closeCodeFor(`${nodeA.wsUrl}/board`)).toBe(CloseCode.Unauthorized);
    expect(await closeCodeFor(`${nodeA.wsUrl}/board?token=garbage`)).toBe(CloseCode.Unauthorized);
    const token = await issueToken('acme');
    expect(await closeCodeFor(`${nodeA.wsUrl}/Bad_Room?token=${token}`)).toBe(CloseCode.BadRequest);
  });

  it('refuses cross-site origins at the handshake', async () => {
    const token = await issueToken('acme');
    const code = await closeCodeFor(`${nodeA.wsUrl}/board?token=${token}`, {
      Origin: 'https://evil.example',
    });
    expect(code).toBe(403);
  });
});

describe('anti-entropy', () => {
  /** Simulates Redis Pub/Sub's at-most-once delivery by dropping the first document update. */
  class DroppingBackplane extends MemoryBackplane {
    dropped = 0;
    override async publish(roomKey: string, message: BackplaneMessage): Promise<void> {
      if (message.kind === BackplaneKind.DocUpdate && this.dropped === 0) {
        this.dropped++;
        return;
      }
      return super.publish(roomKey, message);
    }
  }

  it('repairs a dropped backplane message by gossiping state vectors', async () => {
    const backplane = new DroppingBackplane();
    const store = new MemoryDocumentStore();
    const env = { ANTI_ENTROPY_INTERVAL_MS: '50' };
    const a = await startTestNode({ nodeId: 'a', backplane, store, env });
    const b = await startTestNode({ nodeId: 'b', backplane, store, env });
    const token = await issueToken('acme');
    const alice = connectClient(a.wsUrl, 'lossy', token);
    const bob = connectClient(b.wsUrl, 'lossy', token);
    try {
      await waitFor(() => alice.provider.synced && bob.provider.synced);
      alice.doc.getMap('shapes').set('survives', 1);
      await waitFor(() => bob.doc.getMap('shapes').has('survives'));
      expect(backplane.dropped).toBe(1);
    } finally {
      alice.destroy();
      bob.destroy();
      await Promise.all([a.close(), b.close()]);
    }
  });
});

describe('HTTP API', () => {
  let node: TestNode;

  beforeEach(async () => {
    node = await startTestNode({
      nodeId: 'http',
      backplane: new MemoryBackplane(),
      store: new MemoryDocumentStore(),
      env: { AUTH_DEV_TOKENS: 'true' },
    });
  });
  afterEach(() => node.close());

  it('serves liveness, readiness and metrics', async () => {
    expect((await fetch(`${node.httpUrl}/healthz`)).status).toBe(200);
    const ready = await fetch(`${node.httpUrl}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ready: true });
    expect(await (await fetch(`${node.httpUrl}/metrics`)).text()).toContain('collab_rooms_active');
  });

  it('issues a dev token with CORS for allowed origins', async () => {
    const res = await fetch(`${node.httpUrl}/api/dev-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ tenantId: 'acme', displayName: 'Ada' }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(await res.json()).toMatchObject({
      user: { tenantId: 'acme', name: 'Ada', role: 'editor' },
    });
  });

  it('validates the dev token request body', async () => {
    const res = await fetch(`${node.httpUrl}/api/dev-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: '../etc', displayName: '' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });
});
