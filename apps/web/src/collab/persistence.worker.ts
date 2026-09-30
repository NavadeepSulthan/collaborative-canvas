/// <reference lib="webworker" />
import * as Y from 'yjs';
import { compactRows } from './compact-rows';
import type { PersistenceRequest, PersistenceResponse } from './local-persistence';

// Same store layout as y-indexeddb, so data written by earlier versions is picked up as-is.
const STORE = 'updates';
const WRITE_DEBOUNCE_MS = 100;
const COMPACT_AFTER_ROWS = 200;
/** Above this, compaction merges binary updates instead of rebuilding a doc (a full doc copy can exhaust tab memory). */
const GC_COMPACTION_MAX_BYTES = 16 * 1024 * 1024;

const scope = self as unknown as DedicatedWorkerGlobalScope;
let db: Promise<IDBDatabase> | null = null;
let pending: Uint8Array[] = [];
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<void> = Promise.resolve();
let rows = 0;

scope.onmessage = (event: MessageEvent<PersistenceRequest>) => {
  const message = event.data;
  switch (message.type) {
    case 'open':
      db = open(message.name);
      serial(load);
      break;
    case 'append':
      pending.push(message.update);
      writeTimer ??= setTimeout(() => serial(writePending), WRITE_DEBOUNCE_MS);
      break;
    case 'flush':
      serial(async () => {
        await writePending();
        reply({ type: 'flushed', id: message.id });
      });
      break;
  }
};

/** Runs IndexedDB work strictly one step at a time, reporting failures without stopping the queue. */
function serial(task: () => Promise<void>): void {
  queue = queue
    .then(task)
    .catch((error: unknown) => reply({ type: 'error', message: String(error) }));
}

async function load(): Promise<void> {
  const stored = await getAll();
  rows = stored.length;
  // Rows go to the main thread as-is (transferred, not copied); it applies them in one transaction.
  reply(
    { type: 'loaded', updates: stored },
    stored.map((row) => row.buffer as ArrayBuffer),
  );
  if (rows > COMPACT_AFTER_ROWS) await compact();
}

async function writePending(): Promise<void> {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  const tx = (await db!).transaction(STORE, 'readwrite');
  tx.objectStore(STORE).add(batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch));
  await done(tx);
  if (++rows >= COMPACT_AFTER_ROWS) await compact();
}

/** Replaces exactly the rows read with one compacted row; rows added meanwhile survive. */
async function compact(): Promise<void> {
  const database = await db!;
  const read = database.transaction(STORE, 'readonly').objectStore(STORE);
  const [values, keys] = await Promise.all([request(read.getAll()), request(read.getAllKeys())]);
  if (values.length < 2) return;
  const updates = values as Uint8Array[];
  const bytes = updates.reduce((n, u) => n + u.byteLength, 0);
  const state = bytes <= GC_COMPACTION_MAX_BYTES ? compactRows(updates) : Y.mergeUpdates(updates);
  const tx = database.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  store.delete(IDBKeyRange.upperBound(keys[keys.length - 1]!));
  store.add(state);
  await done(tx);
  rows = await request(database.transaction(STORE, 'readonly').objectStore(STORE).count());
}

async function getAll(): Promise<Uint8Array[]> {
  const store = (await db!).transaction(STORE, 'readonly').objectStore(STORE);
  return (await request(store.getAll())) as Uint8Array[];
}

function open(name: string): Promise<IDBDatabase> {
  const req = indexedDB.open(name);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains(STORE))
      req.result.createObjectStore(STORE, { autoIncrement: true });
    if (!req.result.objectStoreNames.contains('custom')) req.result.createObjectStore('custom');
  };
  return request(req);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reply(message: PersistenceResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}
