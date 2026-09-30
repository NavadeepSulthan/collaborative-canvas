import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { CollabMetrics } from '../collab/ports.js';

/** Prometheus metrics exposed on GET /metrics. */
export function createMetrics(): { registry: Registry; collab: CollabMetrics } {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const rooms = new Gauge({
    name: 'collab_rooms_active',
    help: 'Rooms loaded on this node',
    registers: [registry],
  });
  const peers = new Gauge({
    name: 'collab_peers_connected',
    help: 'Connected WebSocket peers',
    registers: [registry],
  });
  const messages = new Counter({
    name: 'collab_messages_received_total',
    help: 'Client messages by protocol type',
    labelNames: ['type'],
    registers: [registry],
  });
  const backplane = new Counter({
    name: 'collab_backplane_messages_total',
    help: 'Backplane messages by direction',
    labelNames: ['direction'],
    registers: [registry],
  });
  const persist = new Histogram({
    name: 'collab_persist_duration_seconds',
    help: 'Delta log write latency',
    labelNames: ['result'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1],
    registers: [registry],
  });
  const compactions = new Counter({
    name: 'collab_compactions_total',
    help: 'Snapshot compactions by result',
    labelNames: ['result'],
    registers: [registry],
  });

  return {
    registry,
    collab: {
      roomOpened: () => rooms.inc(),
      roomClosed: () => rooms.dec(),
      peerJoined: () => peers.inc(),
      peerLeft: () => peers.dec(),
      messageReceived: (type) => messages.inc({ type }),
      backplane: (direction) => backplane.inc({ direction }),
      persisted: (result, seconds) => persist.observe({ result }, seconds),
      compacted: (result) => compactions.inc({ result }),
    },
  };
}
