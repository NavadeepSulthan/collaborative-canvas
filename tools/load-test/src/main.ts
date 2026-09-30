import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Worker } from 'node:worker_threads';
import { COLLAB_PATH_PREFIX, devTokenResponseSchema } from '@canvas/shared';
import {
  sameState,
  type ClientSpec,
  type EditorReport,
  type FromWorker,
  type ObserverReport,
  type RoomState,
  type ToWorker,
} from './messages.js';
import { parseOptions, type LoadTestOptions } from './options.js';
import { nowMs, SimClient } from './sim-client.js';
import { formatBytes, round, summarize } from './stats.js';

interface ServerSample {
  cpuSeconds: number;
  rssBytes: number;
  eventLoopP99Ms: number;
}

async function main(): Promise<void> {
  const options = parseOptions();
  const wsUrl = `${options.url.replace(/^http/, 'ws')}${COLLAB_PATH_PREFIX}`;
  const token = await fetchToken(options);
  const rooms = Array.from({ length: options.rooms }, (_, i) => `load-${i}`);
  const editsPerClient = Math.ceil(options.edits / options.clients);

  const editors: ClientSpec[] = Array.from({ length: options.clients }, (_, i) => ({
    index: i,
    room: rooms[i % rooms.length]!,
    role: 'editor',
  }));
  const observers: ClientSpec[] = rooms.flatMap((room, r) =>
    Array.from({ length: options.observersPerRoom }, (_, k) => ({
      index: options.clients + r * options.observersPerRoom + k,
      room,
      role: 'observer' as const,
    })),
  );

  console.log(
    `\nLoad test → ${options.url}\n` +
      `  ${options.clients} editing users + ${observers.length} observers, ${options.rooms} board(s) ` +
      `(~${Math.round(options.clients / options.rooms)} users each)\n` +
      `  ${editsPerClient * options.clients} edits at ${options.rate}/s per user ` +
      `(target ${options.clients * options.rate} edits/s), cursors ${options.cursorHz} Hz, ${options.workers} generator threads\n`,
  );

  // Editors are dealt round-robin; observers get their own thread so their timing isn't skewed.
  const editorGroups: ClientSpec[][] = Array.from({ length: options.workers }, () => []);
  editors.forEach((spec, i) => editorGroups[i % options.workers]!.push(spec));
  const editorWorkers = editorGroups.filter((g) => g.length > 0).map(() => spawnWorker());
  const observerWorker = spawnWorker();
  const allWorkers = [...editorWorkers, observerWorker];

  const connectStarted = nowMs();
  const ready = await Promise.all([
    ...editorWorkers.map((w, i) =>
      request(
        w,
        {
          type: 'init',
          wsUrl,
          token,
          clients: editorGroups[i]!,
          editsPerClient,
          rate: options.rate,
          cursorHz: options.cursorHz,
        },
        'ready',
      ),
    ),
    request(
      observerWorker,
      { type: 'init', wsUrl, token, clients: observers, editsPerClient: 0, rate: 1, cursorHz: 0 },
      'ready',
    ),
  ]);
  const connected = ready.reduce((n, r) => n + r.connected, 0);
  const failedConnects = ready.reduce((n, r) => n + r.failed, 0);
  const connectSummary = summarize(ready.flatMap((r) => r.connectMs));
  console.log(
    `Connected ${connected}/${editors.length + observers.length} sockets in ${round((nowMs() - connectStarted) / 1000, 2)}s ` +
      `(p95 handshake+sync ${connectSummary.p95} ms)`,
  );
  if (failedConnects > 0) console.warn(`  ⚠ ${failedConnects} connections failed`);

  const before = await scrape(options.url);
  const samples: ServerSample[] = [];
  const sampler = setInterval(
    () =>
      void scrape(options.url)
        .then((s) => samples.push(s))
        .catch(() => undefined),
    500,
  );

  const startAt = nowMs() + 300;
  const progress = new Map<Worker, number>();
  const progressTimer = setInterval(() => {
    const done = [...progress.values()].reduce((a, b) => a + b, 0);
    const elapsed = (nowMs() - startAt) / 1000;
    if (elapsed > 0)
      process.stdout.write(`\r  ${done} edits sent · ${Math.round(done / elapsed)} edits/s   `);
  }, 1000);
  for (const w of editorWorkers)
    w.on('message', (m: FromWorker) => m.type === 'progress' && progress.set(w, m.edits));

  allWorkers.forEach((w) => w.postMessage({ type: 'go', startAt } satisfies ToWorker));
  const editorReports = await Promise.all(editorWorkers.map((w) => waitFor(w, 'edits-done')));
  const editsFinishedAt = nowMs();
  clearInterval(progressTimer);
  process.stdout.write('\n');

  const expected = mergeExpected(editorReports.map((r) => r.report));
  const observerReport = (
    await request(
      observerWorker,
      { type: 'finish', expected, editsFinishedAt, maxWaitMs: 60_000 },
      'final',
    )
  ).report;
  clearInterval(sampler);
  const after = await scrape(options.url);

  const observerMismatches = observerReport.states.filter(
    (s) => !sameState(expected[s.room] ?? {}, s.state),
  ).length;
  console.log('Verifying with late joiners (fresh clients that only sync from the server)…');
  const lateMismatches = await verifyLateJoiners(rooms, wsUrl, token, expected);

  await Promise.all(allWorkers.map((w) => w.terminate()));
  printReport(options, {
    editorReports: editorReports.map((r) => r.report),
    observerReport,
    startAt,
    editsFinishedAt,
    before,
    after,
    samples,
    connected,
    failedConnects,
    connectP95: connectSummary.p95,
    observers: observers.length,
    observerMismatches,
    lateMismatches,
    rooms: rooms.length,
    expectedShapes: Object.values(expected).reduce((n, s) => n + Object.keys(s).length, 0),
  });
}

function spawnWorker(): Worker {
  return new Worker(new URL('./worker-entry.mjs', import.meta.url));
}

function request<T extends FromWorker['type']>(worker: Worker, message: ToWorker, reply: T) {
  const response = waitFor(worker, reply);
  worker.postMessage(message);
  return response;
}

function waitFor<T extends FromWorker['type']>(
  worker: Worker,
  type: T,
): Promise<Extract<FromWorker, { type: T }>> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: FromWorker) => {
      if (message.type !== type) return;
      worker.off('message', onMessage);
      resolve(message as Extract<FromWorker, { type: T }>);
    };
    worker.on('message', onMessage);
    worker.once('error', reject);
  });
}

async function fetchToken(options: LoadTestOptions): Promise<string> {
  const res = await fetch(`${options.url}/api/dev-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId: options.tenant, displayName: 'Load Bot', role: 'editor' }),
  });
  if (!res.ok)
    throw new Error(
      `token request failed (${res.status}). Is the server running with AUTH_DEV_TOKENS=true?`,
    );
  return devTokenResponseSchema.parse(await res.json()).token;
}

async function scrape(url: string): Promise<ServerSample> {
  const text = await (await fetch(`${url}/metrics`)).text();
  const metric = (name: string) =>
    Number(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, 'm').exec(text)?.[1] ?? 0);
  return {
    cpuSeconds: metric('process_cpu_seconds_total'),
    rssBytes: metric('process_resident_memory_bytes'),
    eventLoopP99Ms: metric('nodejs_eventloop_lag_p99_seconds') * 1000,
  };
}

function mergeExpected(reports: EditorReport[]): Record<string, RoomState> {
  const expected: Record<string, RoomState> = {};
  for (const report of reports) {
    for (const [room, shapes] of Object.entries(report.ownShapes))
      Object.assign((expected[room] ??= {}), shapes);
  }
  return expected;
}

async function verifyLateJoiners(
  rooms: string[],
  wsUrl: string,
  token: string,
  expected: Record<string, RoomState>,
) {
  let mismatches = 0;
  for (let i = 0; i < rooms.length; i += 25) {
    await Promise.all(
      rooms.slice(i, i + 25).map(async (room, k) => {
        const client = new SimClient(
          { index: 1_000_000 + i + k, room, role: 'observer' },
          wsUrl,
          token,
        );
        try {
          await client.connect();
          if (!sameState(expected[room] ?? {}, client.fullState())) mismatches++;
        } catch {
          mismatches++;
        } finally {
          client.close();
        }
      }),
    );
  }
  return mismatches;
}

interface RunResult {
  editorReports: EditorReport[];
  observerReport: ObserverReport;
  startAt: number;
  editsFinishedAt: number;
  before: ServerSample;
  after: ServerSample;
  samples: ServerSample[];
  connected: number;
  failedConnects: number;
  connectP95: number;
  observers: number;
  observerMismatches: number;
  lateMismatches: number;
  rooms: number;
  expectedShapes: number;
}

function printReport(options: LoadTestOptions, r: RunResult): void {
  const total = (pick: (e: EditorReport) => number) =>
    r.editorReports.reduce((n, e) => n + pick(e), 0);
  const editsSent = total((e) => e.editsSent);
  const editSeconds = (r.editsFinishedAt - r.startAt) / 1000;
  const wallSeconds = (nowMs() - r.startAt) / 1000;
  const latency = summarize(r.observerReport.latenciesMs);
  const convergence = summarize(r.observerReport.convergeMs.filter((ms) => ms >= 0));
  const lag = summarize(r.editorReports.flatMap((e) => e.scheduleLagMs));
  const cpuSeconds = r.after.cpuSeconds - r.before.cpuSeconds;
  const peakRss = Math.max(
    r.before.rssBytes,
    r.after.rssBytes,
    ...r.samples.map((s) => s.rssBytes),
  );
  const peakLoopLag = Math.max(0, ...r.samples.map((s) => s.eventLoopP99Ms));
  const disconnects = total((e) => e.disconnects) + r.observerReport.disconnects;
  const converged =
    r.observerMismatches === 0 &&
    r.lateMismatches === 0 &&
    disconnects === 0 &&
    r.failedConnects === 0;

  const report = {
    scenario: {
      url: options.url,
      editingUsers: options.clients,
      observers: r.observers,
      boards: r.rooms,
      usersPerBoard: Math.round(options.clients / r.rooms),
      ratePerUser: options.rate,
      cursorHz: options.cursorHz,
    },
    throughput: {
      editsSent,
      editPhaseSeconds: round(editSeconds, 2),
      editsPerSecond: Math.round(editsSent / editSeconds),
    },
    latencyMs: latency,
    convergenceAfterLastEditMs: { max: convergence.max, p50: convergence.p50 },
    fanOut: {
      framesDeliveredToEditors: total((e) => e.framesIn),
      bytesDeliveredToEditors: total((e) => e.bytesIn),
      framesDeliveredToObservers: r.observerReport.framesIn,
      bytesSentByEditors: total((e) => e.bytesOut),
    },
    server: {
      cpuSeconds: round(cpuSeconds, 2),
      avgCpuPercentOfOneCore: Math.round((cpuSeconds / wallSeconds) * 100),
      peakRssMB: Math.round(peakRss / 1e6),
      peakEventLoopLagP99Ms: round(peakLoopLag, 1),
    },
    reliability: {
      connected: r.connected,
      failedConnects: r.failedConnects,
      unexpectedDisconnects: disconnects,
      connectP95Ms: r.connectP95,
      expectedShapes: r.expectedShapes,
      observersMatchingEditors: `${r.observers - r.observerMismatches}/${r.observers}`,
      lateJoinersMatchingEditors: `${r.rooms - r.lateMismatches}/${r.rooms}`,
      converged,
    },
    generatorHealth: { scheduleLagP99Ms: lag.p99 },
  };

  console.log(`
┌──────────────────────────── RESULTS ────────────────────────────┐
  Users                ${options.clients} editors + ${r.observers} observers on ${r.rooms} board(s)
  Edits sent           ${editsSent} in ${round(editSeconds, 2)} s  →  ${report.throughput.editsPerSecond} edits/s
  Edit → other screen  p50 ${latency.p50} ms · p95 ${latency.p95} ms · p99 ${latency.p99} ms · max ${latency.max} ms  (${latency.count} samples)
  Fan-out delivered    ${formatBytes(report.fanOut.bytesDeliveredToEditors)} in ${report.fanOut.framesDeliveredToEditors} frames to editors
  Server CPU           ${report.server.cpuSeconds} s (${report.server.avgCpuPercentOfOneCore}% of one core avg)
  Server memory        peak RSS ${report.server.peakRssMB} MB · event-loop p99 lag peak ${report.server.peakEventLoopLagP99Ms} ms
  Connections          ${r.connected} ok · ${r.failedConnects} failed · ${disconnects} dropped · handshake p95 ${r.connectP95} ms
  Convergence          ${r.expectedShapes} shapes · observers ${report.reliability.observersMatchingEditors} · late joiners ${report.reliability.lateJoinersMatchingEditors} · all in sync ${convergence.max} ms after last edit
  Verdict              ${converged ? '✅ every client converged to the exact same state' : '❌ divergence or connection errors detected'}
  Generator health     schedule lag p99 ${lag.p99} ms ${lag.p99 > 50 ? '(⚠ load generator saturated; latency numbers are pessimistic)' : '(generator kept up)'}
└─────────────────────────────────────────────────────────────────┘`);

  if (options.out) {
    const out = options.out;
    void mkdir(dirname(out), { recursive: true }).then(() =>
      writeFile(out, JSON.stringify(report, null, 2)),
    );
  }
  process.exitCode = converged ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
