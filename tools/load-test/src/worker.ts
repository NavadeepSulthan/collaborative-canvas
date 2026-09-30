import { parentPort } from 'node:worker_threads';
import { sameState, type FromWorker, type RoomState, type ToWorker } from './messages.js';
import { nowMs, SimClient } from './sim-client.js';

const CONNECT_BATCH = 50;
const TICK_MS = 5;

if (!parentPort) throw new Error('worker.ts must run as a worker thread');
const port = parentPort;
const post = (message: FromWorker) => port.postMessage(message);

let clients: SimClient[] = [];
let settings: Extract<ToWorker, { type: 'init' }>;

port.on('message', (message: ToWorker) => {
  switch (message.type) {
    case 'init':
      settings = message;
      void connectAll();
      break;
    case 'go':
      clients.forEach((c) => c.startMeasuring(message.startAt));
      if (clients[0]?.spec.role === 'editor') runEdits(message.startAt);
      break;
    case 'finish':
      void finishObservers(message.expected, message.editsFinishedAt, message.maxWaitMs);
      break;
  }
});

async function connectAll(): Promise<void> {
  const connectMs: number[] = [];
  let failed = 0;
  const all = settings.clients.map((spec) => new SimClient(spec, settings.wsUrl, settings.token));
  // Batches avoid overflowing the server's TCP accept backlog.
  for (let i = 0; i < all.length; i += CONNECT_BATCH) {
    await Promise.all(
      all.slice(i, i + CONNECT_BATCH).map(async (client) => {
        const started = nowMs();
        try {
          await client.connect();
          connectMs.push(nowMs() - started);
        } catch {
          failed++;
        }
      }),
    );
  }
  clients = all;
  post({ type: 'ready', connected: all.length - failed, failed, connectMs });
}

/** Paced open-loop schedule: each user edits at `rate`/s with a random phase, regardless of replies. */
function runEdits(startAt: number): void {
  const { editsPerClient, rate, cursorHz } = settings;
  const interval = 1000 / rate;
  const cursorInterval = cursorHz > 0 ? 1000 / cursorHz : Infinity;
  const plan = clients.map(() => ({ phase: Math.random() * interval, done: 0, cursors: 0 }));
  const scheduleLagMs: number[] = [];
  let totalDone = 0;
  let lastProgress = nowMs();

  const tick = () => {
    const now = nowMs();
    let remaining = false;
    clients.forEach((client, i) => {
      const p = plan[i]!;
      while (p.done < editsPerClient) {
        const due = startAt + p.phase + p.done * interval;
        if (due > now) break;
        scheduleLagMs.push(now - due);
        client.edit();
        p.done++;
        totalDone++;
      }
      if (p.done < editsPerClient) {
        remaining = true;
        while (startAt + p.phase + p.cursors * cursorInterval <= now) {
          client.moveCursor();
          p.cursors++;
        }
      }
    });
    if (now - lastProgress > 1000) {
      post({ type: 'progress', edits: totalDone });
      lastProgress = now;
    }
    if (remaining) {
      setTimeout(tick, TICK_MS);
      return;
    }
    post({ type: 'progress', edits: totalDone });
    post({
      type: 'edits-done',
      report: {
        editsSent: totalDone,
        framesIn: sum(clients.map((c) => c.stats.framesIn)),
        bytesIn: sum(clients.map((c) => c.stats.bytesIn)),
        framesOut: sum(clients.map((c) => c.stats.framesOut)),
        bytesOut: sum(clients.map((c) => c.stats.bytesOut)),
        disconnects: sum(clients.map((c) => c.stats.disconnects)),
        scheduleLagMs,
        ownShapes: groupOwnShapes(),
      },
    });
  };
  setTimeout(tick, Math.max(0, startAt - nowMs()));
}

function groupOwnShapes(): Record<string, Record<string, string>> {
  const byRoom: Record<string, Record<string, string>> = {};
  for (const client of clients) Object.assign((byRoom[client.spec.room] ??= {}), client.ownState());
  return byRoom;
}

/** Polls until every observer's document equals the editors' combined final state. */
async function finishObservers(
  expected: Record<string, RoomState>,
  editsFinishedAt: number,
  maxWaitMs: number,
): Promise<void> {
  const convergeMs = clients.map(() => -1);
  const deadline = nowMs() + maxWaitMs;
  while (nowMs() < deadline && convergeMs.includes(-1)) {
    clients.forEach((client, i) => {
      if (convergeMs[i] !== -1) return;
      const target = expected[client.spec.room] ?? {};
      if (
        client.shapeCount === Object.keys(target).length &&
        sameState(target, client.fullState())
      ) {
        convergeMs[i] = Math.max(0, nowMs() - editsFinishedAt);
      }
    });
    await new Promise((r) => setTimeout(r, 50));
  }
  post({
    type: 'final',
    report: {
      latenciesMs: clients.flatMap((c) => c.latenciesMs),
      convergeMs,
      framesIn: sum(clients.map((c) => c.stats.framesIn)),
      bytesIn: sum(clients.map((c) => c.stats.bytesIn)),
      disconnects: sum(clients.map((c) => c.stats.disconnects)),
      states: clients.map((c) => ({ room: c.spec.room, state: c.fullState() })),
    },
  });
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
