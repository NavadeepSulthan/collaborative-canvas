import pg from 'pg';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../observability/logger.js';
import { compactUpdates } from '../collab/compaction.js';
import { BackplaneKind, type BackplaneMessage } from '../collab/ports.js';
import { migrate } from './postgres/migrate.js';
import { PostgresDocumentStore } from './postgres/postgres-document-store.js';
import { RedisBackplane } from './redis/redis-backplane.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

function updateSetting(key: string, value: number): Uint8Array {
  const doc = new Y.Doc();
  let update: Uint8Array | undefined;
  doc.on('update', (u: Uint8Array) => (update = u));
  doc.getMap('m').set(key, value);
  return update!;
}

// Runs only when real infrastructure is available (docker compose up, or in CI service containers).
describe.skipIf(!DATABASE_URL)('PostgresDocumentStore', () => {
  let store: PostgresDocumentStore;
  const room = `test/${Date.now()}`;

  beforeAll(async () => {
    await migrate(DATABASE_URL!, () => undefined);
    store = PostgresDocumentStore.connect(DATABASE_URL!);
  });
  afterAll(() => store.close());

  it('appends, compacts, and loads the same state', async () => {
    for (let i = 0; i < 5; i++) await store.append(room, updateSetting(`k${i}`, i));
    const result = await store.compact(room, compactUpdates);
    expect(result?.mergedUpdates).toBe(5);

    await store.append(room, updateSetting('late', 99));
    const doc = new Y.Doc();
    for (const u of await store.load(room)) Y.applyUpdate(doc, u);
    expect(doc.getMap('m').toJSON()).toEqual({ k0: 0, k1: 1, k2: 2, k3: 3, k4: 4, late: 99 });
  });

  it('skips compaction while another node holds the room lock', async () => {
    await store.append(room, updateSetting('x', 1));
    const other = new pg.Client({ connectionString: DATABASE_URL });
    await other.connect();
    try {
      await other.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [room]);
      expect(await store.compact(room, compactUpdates)).toBeNull();
      await other.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [room]);
      expect(await store.compact(room, compactUpdates)).toMatchObject({ mergedUpdates: 1 });
    } finally {
      await other.end();
    }
  });
});

describe.skipIf(!REDIS_URL)('RedisBackplane', () => {
  const logger = createLogger({ level: 'silent', nodeId: 'test' });

  it('delivers binary messages between two instances', async () => {
    const a = new RedisBackplane(REDIS_URL!, logger);
    const b = new RedisBackplane(REDIS_URL!, logger);
    try {
      const received = new Promise<BackplaneMessage>((resolve) => {
        void b.subscribe('acme/room', resolve);
      });
      await new Promise((r) => setTimeout(r, 100));
      const message = {
        origin: 'a',
        kind: BackplaneKind.DocUpdate,
        payload: new Uint8Array([0, 255, 7]),
      };
      await a.publish('acme/room', message);
      expect(await received).toEqual(message);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});
