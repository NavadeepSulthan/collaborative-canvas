import pg from 'pg';
import type { CompactionResult, DocumentStore } from '../../collab/ports.js';

/**
 * PostgreSQL-backed delta log + snapshot store.
 *
 * Compaction runs in one transaction guarded by a per-room advisory lock, and deletes
 * exactly the rows it read (by seq) — never "seq <= max". A concurrent insert whose
 * sequence number was allocated earlier but committed later is therefore never lost;
 * it's simply folded into the next compaction.
 */
export class PostgresDocumentStore implements DocumentStore {
  constructor(private readonly pool: pg.Pool) {}

  static connect(connectionString: string): PostgresDocumentStore {
    return new PostgresDocumentStore(new pg.Pool({ connectionString, max: 10 }));
  }

  async load(roomKey: string): Promise<Uint8Array[]> {
    const snapshot = await this.pool.query<{ state: Buffer }>(
      'SELECT state FROM document_snapshots WHERE room_key = $1',
      [roomKey],
    );
    const updates = await this.pool.query<{ update: Buffer }>(
      'SELECT update FROM document_updates WHERE room_key = $1 ORDER BY seq',
      [roomKey],
    );
    return [...snapshot.rows.map((r) => r.state), ...updates.rows.map((r) => r.update)].map(
      toUint8Array,
    );
  }

  async append(roomKey: string, update: Uint8Array): Promise<void> {
    await this.pool.query('INSERT INTO document_updates (room_key, update) VALUES ($1, $2)', [
      roomKey,
      Buffer.from(update),
    ]);
  }

  async compact(
    roomKey: string,
    merge: (updates: Uint8Array[]) => Uint8Array,
  ): Promise<CompactionResult | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
        [roomKey],
      );
      if (!lock.rows[0]?.locked) {
        await client.query('ROLLBACK');
        return null;
      }
      const snapshot = await client.query<{ state: Buffer }>(
        'SELECT state FROM document_snapshots WHERE room_key = $1',
        [roomKey],
      );
      const updates = await client.query<{ seq: string; update: Buffer }>(
        'SELECT seq, update FROM document_updates WHERE room_key = $1 ORDER BY seq',
        [roomKey],
      );
      if (updates.rowCount === 0) {
        await client.query('COMMIT');
        return { mergedUpdates: 0, snapshotBytes: snapshot.rows[0]?.state.byteLength ?? 0 };
      }
      const merged = merge(
        [...snapshot.rows.map((r) => r.state), ...updates.rows.map((r) => r.update)].map(
          toUint8Array,
        ),
      );
      await client.query(
        `INSERT INTO document_snapshots (room_key, state) VALUES ($1, $2)
         ON CONFLICT (room_key) DO UPDATE
           SET state = EXCLUDED.state,
               version = document_snapshots.version + 1,
               updated_at = now()`,
        [roomKey, Buffer.from(merged)],
      );
      await client.query('DELETE FROM document_updates WHERE seq = ANY($1::bigint[])', [
        updates.rows.map((r) => r.seq),
      ]);
      await client.query('COMMIT');
      return { mergedUpdates: updates.rows.length, snapshotBytes: merged.byteLength };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function toUint8Array(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
