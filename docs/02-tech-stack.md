# 02 — Tech Stack

Only what this project actually uses. Everything is free and open-source.

## Languages & tooling

| Tech                    | Used for                          | Why this choice                                                         |
| ----------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| **TypeScript** (strict) | All code                          | One language front-to-back; strict mode + `noUncheckedIndexedAccess`.   |
| **Node.js 20**          | Server runtime                    | Great WebSocket ecosystem; Yjs runs natively (same code on both ends).  |
| **npm workspaces**      | Monorepo (`packages/*`, `apps/*`) | Zero extra tooling; lets client and server share one contracts package. |
| **ESLint + Prettier**   | Linting / formatting              | Enforced in CI.                                                         |

## Shared

| Tech    | Used for                                  | Why                                                                                                                                        |
| ------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Zod** | Request/response + env validation schemas | Single source of truth: the same schema validates on the server and types the client. **End-to-end type safety** without a code generator. |

## Real-time & data

| Tech                        | Used for                                             | Why / alternative                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Yjs**                     | CRDT document model (`Y.Map`, `Y.Text`, UndoManager) | Fastest mature CRDT for JS, compact binary updates. Alt: Automerge.                                                                                                             |
| **y-protocols**             | Sync (state-vector diff) + awareness protocols       | Standard wire protocol; server speaks it directly.                                                                                                                              |
| **y-websocket** (client)    | Browser WebSocket provider with reconnect/backoff    | We implement the **server** ourselves (rooms, auth, backplane, RBAC).                                                                                                           |
| **IndexedDB + Web Worker**  | Offline cache of the board in the browser            | Local-first. A dedicated worker does all I/O and compaction, so large boards never stall rendering (replaced `y-indexeddb`, which re-encodes the whole doc on the main thread). |
| **ws**                      | Server WebSocket implementation                      | Minimal, fast, supports `noServer` upgrades + backpressure info.                                                                                                                |
| **Redis Pub/Sub** (ioredis) | Backplane between server nodes                       | Simple fan-out, sub-millisecond. Alt: NATS.                                                                                                                                     |
| **PostgreSQL** (pg)         | Delta log + snapshots (`BYTEA`), advisory locks      | Transactions + advisory locks make compaction safe. Alt: S3 for blobs.                                                                                                          |

## Frontend

| Tech                                    | Used for                              | Why                                                                                                                     |
| --------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **React 19**                            | UI chrome (toolbar, presence, status) | `useSyncExternalStore` binds cleanly to our non-React stores.                                                           |
| **HTML5 Canvas 2D** + `OffscreenCanvas` | The board itself; cached shape layer  | Thousands of objects without thousands of DOM nodes; the offscreen layer makes frame cost proportional to what changed. |
| **Vite**                                | Dev server + production bundling      | Fast HMR, simple config.                                                                                                |

The rendering engine (`apps/web/src/canvas`) is **framework-agnostic TypeScript**; React only
hosts it.

## Security

| Tech     | Used for                     |
| -------- | ---------------------------- |
| **jose** | Signing/verifying HS256 JWTs |

## Observability

| Tech                    | Used for                                                                 |
| ----------------------- | ------------------------------------------------------------------------ |
| **OpenTelemetry SDK**   | Traces (`ws.upgrade`, `room.open`, `room.persist`, `room.compact`, HTTP) |
| **Jaeger** (all-in-one) | Trace UI (local, via Docker)                                             |
| **pino**                | Structured JSON logs with `trace_id` / `span_id`                         |
| **prom-client**         | Prometheus metrics at `/metrics`                                         |

## Testing & delivery

| Tech                 | Used for                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| **Vitest**           | Unit + integration tests (real servers on random ports)                                        |
| **Playwright**       | Multi-user browser E2E (separate contexts = separate users)                                    |
| **Docker / Compose** | Images for server and web (nginx); local production-like stack                                 |
| **GitHub Actions**   | CI (lint, typecheck, tests with Postgres/Redis service containers, E2E) and CD (images → GHCR) |
| **Dependabot**       | Automated dependency updates                                                                   |
