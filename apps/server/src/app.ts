import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Backplane, DocumentStore } from './collab/ports.js';
import { RoomRegistry } from './collab/room-registry.js';
import type { AppConfig } from './config.js';
import { createRequestHandler } from './http/http-routes.js';
import { TokenService } from './http/token-service.js';
import { WebSocketGateway } from './http/websocket-gateway.js';
import type { Logger } from './observability/logger.js';
import { createMetrics } from './observability/metrics.js';

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  backplane: Backplane;
  store: DocumentStore;
}

export interface App {
  server: Server;
  rooms: RoomRegistry;
  listen(): Promise<AddressInfo>;
  /** Graceful shutdown: drain sockets, flush rooms. Infrastructure clients are closed by the caller. */
  close(): Promise<void>;
}

/** Wires the collaboration core to HTTP/WebSocket transport. Pure composition, no I/O at construction. */
export function createApp({ config, logger, backplane, store }: AppDeps): App {
  const { registry: metricsRegistry, collab: metrics } = createMetrics();
  const tokens = new TokenService(config.jwtSecret);
  const rooms = new RoomRegistry({
    nodeId: config.nodeId,
    backplane,
    store,
    metrics,
    logger,
    persistDebounceMs: config.persistDebounceMs,
    compactionThreshold: config.compactionThreshold,
    broadcastIntervalMs: config.broadcastIntervalMs,
    idleTtlMs: config.roomIdleTtlMs,
    antiEntropyIntervalMs: config.antiEntropyIntervalMs,
  });
  const gateway = new WebSocketGateway({ config, tokens, rooms, logger });
  let draining = false;

  const server = createServer(
    createRequestHandler({
      config,
      tokens,
      metricsRegistry,
      logger,
      readiness: async () => {
        const [backplaneOk, storeOk] = await Promise.all([
          backplane.isHealthy(),
          store.isHealthy(),
        ]);
        const checks = { backplane: backplaneOk, store: storeOk, accepting: !draining };
        return { ready: Object.values(checks).every(Boolean), checks };
      },
    }),
  );
  server.on('upgrade', gateway.handleUpgrade);

  return {
    server,
    rooms,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => resolve(server.address() as AddressInfo));
      }),
    close: async () => {
      draining = true;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      await gateway.close();
      await rooms.shutdown();
      server.closeAllConnections();
      await closed;
    },
  };
}
