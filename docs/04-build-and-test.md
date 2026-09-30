# 04 — Build, Run & Test (step by step)

## 0. Prerequisites

| Tool              | Needed for                                  | Install (free)                                                |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------- |
| Node.js ≥ 20.19   | everything                                  | <https://nodejs.org> (or `nvm install 20`)                    |
| npm ≥ 10          | comes with Node                             |                                                               |
| Docker (optional) | Postgres/Redis/Jaeger, cluster mode, images | Docker Desktop or `brew install colima docker docker-compose` |

Check: `node -v && npm -v` (and `docker -v` if using Docker).

## 1. Install

```bash
cd collaborative-canvas
npm install                 # installs all workspaces
npm run build:shared        # compiles the shared contracts package
```

## 2. Run: single node, no Docker (fastest)

```bash
npm run dev
```

- Server: <http://localhost:4000> (in-memory store and backplane; data resets on restart)
- Web: <http://localhost:5173>

### Try it

1. Open <http://localhost:5173>, enter a name, keep workspace `acme` / board `design-review`, click **Join board**.
2. Open a **second window** (or an incognito window) and join the same board with another name.
3. In window 1 press **R** and drag on the canvas → the rectangle appears in window 2 instantly.
4. Move your mouse → window 2 shows your named cursor gliding smoothly.
5. Select a shape in window 1 → window 2 shows a dashed outline in your color.
6. Press **N**, click, type in the note. Type in the same note from window 2 at the same time. Both edits merge.
7. **⌘/Ctrl+Z** undoes only _your_ changes.

### Keyboard shortcuts

| Key               | Action                     | Key                  | Action                     |
| ----------------- | -------------------------- | -------------------- | -------------------------- |
| V                 | Select                     | Space (hold)         | Pan                        |
| H                 | Pan tool                   | ⌘/Ctrl + scroll      | Zoom                       |
| R / O / N         | Rectangle / Ellipse / Note | + / − / ⇧1           | Zoom in / out / fit        |
| ⌫ / Delete        | Delete selection           | ⌘/Ctrl + Z / ⇧Z      | Undo / redo                |
| ⌘/Ctrl + A        | Select all                 | Esc                  | Deselect                   |
| Double-click note | Edit text                  | Shift + click / drag | Add to selection / marquee |

## 3. Manual test scenarios

| #   | Scenario               | Steps                                                                                                                          | Expected                                                                                                                          |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Offline edits          | Window 1: **Dev tools → Simulate offline**. Draw 2 shapes. Window 2 draws 1. Uncheck offline.                                  | Status shows _Offline_ then _Live_; both windows end with all 3 shapes.                                                           |
| 2   | Survive reload offline | Stop the server (`Ctrl+C`), reload window 1.                                                                                   | Board still opens from IndexedDB; edits allowed; they sync when the server returns.                                               |
| 3   | Server restart         | Save any server file (tsx hot-reloads) while two windows are open.                                                             | Both reconnect automatically; no edits lost _made after reconnect_. (In-memory mode loses server state; see §4 for durable mode.) |
| 4   | Viewer role            | Join as **viewer**.                                                                                                            | Drawing tools disabled; edits from editors appear live.                                                                           |
| 5   | Tenant isolation       | Window 2 joins workspace `globex`, same board name.                                                                            | Sees an empty board.                                                                                                              |
| 6   | Performance            | **Dev tools → +5,000 shapes** (repeat up to the 100,000 limit), then **Run 3s pan benchmark**. Click a shape and press Delete. | Display refresh rate (60/120 fps), p95 frame ~2–3 ms, delete visible within one frame. Adding past 100,000 shows a banner.        |
| 7   | Bad token              | In DevTools console: `new WebSocket('ws://localhost:4000/collab/x?token=bad')`.                                                | Closed with code `4401`.                                                                                                          |

## 4. Run: durable two-node cluster (Docker for infra)

This shows the Redis backplane and Postgres persistence.

```bash
cp .env.example apps/server/.env
# edit apps/server/.env and uncomment REDIS_URL and DATABASE_URL
npm run infra:up            # Postgres :5432, Redis :6379, Jaeger :16686
npm run dev:cluster         # node-a :4000, node-b :4001, web :5173
```

1. Window 1: join with **Server node = http://localhost:4000**.
2. Window 2: join the same board with **Server node = http://localhost:4001**.
3. Draw in either. Edits cross nodes through Redis.
4. Stop and restart `dev:cluster`, then rejoin. The board is restored from Postgres.
5. Inspect storage:
   ```bash
   docker compose exec postgres psql -U canvas -c \
     "select room_key, count(*) from document_updates group by 1;" -c \
     "select room_key, version, length(state) from document_snapshots;"
   ```
   Close all windows for a board and wait `ROOM_IDLE_TTL_MS` (30 s). The rows fold into the snapshot (compaction).

## 5. Run: full production-like stack in Docker

```bash
docker compose up --build
```

| URL                                              | What                                        |
| ------------------------------------------------ | ------------------------------------------- |
| <http://localhost:8080>                          | Web (nginx, production bundle, CSP headers) |
| <http://localhost:4000>, <http://localhost:4001> | Two server replicas                         |
| <http://localhost:16686>                         | Jaeger. Pick service `collab-server`        |

Stop: `docker compose down` (add `-v` to delete the Postgres volume).

## 6. Observability walkthrough

- **Logs:** JSON lines on stdout, e.g. `{"level":"info","room":"acme/design-review","user_id":"…","msg":"peer connected"}`.
  Inside spans they include `trace_id`.
- **Traces:** the status bar shows `trace <id>`. Search that id in Jaeger to see the
  `ws.upgrade → room.open` spans for your own browser session. The browser created the trace
  (W3C `traceparent`) and the server continued it.
- **Metrics:** `curl localhost:4000/metrics | grep collab_` for rooms, peers, messages by type,
  backplane in/out, persist latency histogram and compactions.
- **Probes:** `/healthz` (liveness), `/readyz` (Redis + Postgres + not draining).

## 7. Automated tests

```bash
npm test                     # all unit + integration tests (shared, server, web)
npm run test:e2e             # Playwright: starts/reuses dev servers automatically
```

First E2E run only: `npx playwright install chromium` (free browser download).

| Suite                      | Location                                               | What it proves                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts                  | `packages/shared/src/*.test.ts`                        | Slug/role validation rules                                                                                                                                              |
| Compaction, envelope       | `apps/server/src/collab/compaction.test.ts`            | Snapshot equals replay; idempotent; binary framing                                                                                                                      |
| Write-behind               | `apps/server/src/collab/write-behind-buffer.test.ts`   | Batching, retry with backoff, serialized flushes                                                                                                                        |
| Auth, rate limit           | `apps/server/src/http/auth.test.ts`                    | JWT round-trip/expiry/forgery; token bucket                                                                                                                             |
| **Multi-node integration** | `apps/server/src/collab/collab.integration.test.ts`    | Two real servers + real WebSocket clients: cross-node convergence, presence, persistence + compaction, tenant isolation, viewer RBAC, auth close codes, CSWSH, HTTP API |
| Real infra                 | `apps/server/src/infrastructure/*.integration.test.ts` | Postgres store + advisory lock, Redis backplane (auto-skips unless `DATABASE_URL` / `REDIS_URL` are set)                                                                |
| Client domain              | `apps/web/src/collab/shape-store.test.ts`              | Concurrent edits merge (props + text), paint order, change events, malformed data ignored                                                                               |
| Canvas math                | `apps/web/src/canvas/canvas.test.ts`                   | Viewport, spatial hash (50k shapes), hit testing, interpolation                                                                                                         |
| **E2E**                    | `e2e/collaboration.spec.ts`                            | Real browsers: live sync, offline merge, viewer, tenant isolation                                                                                                       |

Run the infra-backed tests locally:

```bash
npm run infra:up
DATABASE_URL=postgres://canvas:canvas@localhost:5432/canvas REDIS_URL=redis://localhost:6379 npm test -w @canvas/server
```

## 8. Load testing (1,000 users × 100,000 edits)

`tools/load-test` simulates users as **real WebSocket clients speaking the actual Yjs
protocol**, spread over worker threads:

- **Editors** make paced edits (20% create, 70% move, 10% type) and receive the full fan-out.
  They count incoming bytes but don't integrate them; that CPU belongs to each user's browser.
- **Observers** (separate thread) integrate everything like a real browser and measure
  _edit → other user's screen_ latency from a timestamp embedded in each edit.
- **Verification:** at the end, every observer and a fresh **late joiner** per board must match
  the union of every editor's final shapes **exactly**, or the run exits non-zero.

```bash
# terminal 1: production build of the server
npm run build:shared && npm run build -w @canvas/server
cd apps/server && NODE_ENV=production PORT=4200 AUTH_DEV_TOKENS=true LOG_LEVEL=warn \
  JWT_SECRET=loadtest-secret-loadtest-secret-loadtest node dist/main.js

# terminal 2
npm run load-test -- --url http://localhost:4200 --clients 1000 --edits 100000 --rooms 100
npm run load-test -- --url http://localhost:4200 --clients 1000 --edits 100000 --rooms 1 --observers-per-room 5
npm run load-test -- --help     # all options (rate, cursor Hz, workers, JSON output…)
```

### Results: one Node.js process, in-memory adapters, MacBook (14 cores, 24 GB)

10 edits/s per user for 10 s. Raw JSON is in `tools/load-test/results/`.

| Metric                       | A: 100 boards × 10 users      | B: 1 board × 1,000 users (worst case) |
| ---------------------------- | ----------------------------- | ------------------------------------- |
| Edits / throughput           | 100,000 · 9,962 edits/s       | 100,000 · 9,943 edits/s               |
| Edit → other screen p50/p99  | 14.6 ms / 30.4 ms             | 30.2 ms / 165 ms                      |
| All clients in sync after    | 108 ms                        | 557 ms                                |
| Data delivered to users      | 92.5 MB                       | 9.17 GB (every edit to 999 people)    |
| Server CPU (avg of one core) | 90%                           | 80%                                   |
| Peak event-loop lag (p99)    | 24 ms                         | 117 ms                                |
| Connections / drops          | 1,100 / 0                     | 1,005 / 0                             |
| Convergence                  | ✅ 100/100 + 100 late joiners | ✅ 5/5 + late joiner                  |

**Before/after optimization (scenario B):** the first run failed. It used 240 s of server CPU,
had 6.4 s event-loop stalls and ~1 s p99 latency. A CPU profile showed per-edit Yjs transactions
and repeated `mergeUpdates`; the fix was ingest + fan-out batching (architecture §2.2). Result:
25× less CPU and p99 944 ms → 165 ms.

**What this does _not_ prove:** Redis/Postgres were not in the loop (in-memory adapters), and
clients shared the machine with the server. Presence was set once per user; with cursors
(`--cursor-hz 20`) a 1,000-person room also multiplies presence traffic, so real products
show nearby or active cursors only at that scale.

## 9. Static checks (same as CI)

```bash
npm run format:check && npm run lint && npm run typecheck && npm test && npm run build
```

## 10. Troubleshooting

| Symptom                                      | Fix                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| "Cannot reach http://localhost:4000" on join | Server not running. Check `npm run dev` output.                                                |
| Status stuck on _Connecting…_                | Origin not allowed: add your web origin to `ALLOWED_ORIGINS`.                                  |
| _Rejected: invalid token (4401)_             | Token expired (1 h) or `JWT_SECRET` changed. Click _Sign in again_.                            |
| Port 5173/4000 in use                        | Stop the other process or change `PORT` / Vite `server.port`.                                  |
| Old shapes appear on a fresh server          | That's local-first working: your browser's IndexedDB copy re-synced. Clear site data to reset. |
| `@canvas/shared` import errors               | Run `npm run build:shared`.                                                                    |
