import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { createApp, type App } from '../app.js';
import type { Backplane, DocumentStore } from '../collab/ports.js';
import { loadConfig } from '../config.js';
import { TokenService } from '../http/token-service.js';
import { createLogger } from '../observability/logger.js';

export const TEST_SECRET = 'test-secret-test-secret-test-secret-123';

export interface TestNode {
  app: App;
  httpUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}

/** Boots a real server node on an ephemeral port with the given (shared) infrastructure. */
export async function startTestNode(options: {
  nodeId: string;
  backplane: Backplane;
  store: DocumentStore;
  env?: Record<string, string>;
}): Promise<TestNode> {
  const config = loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '0',
    NODE_ID: options.nodeId,
    LOG_LEVEL: 'silent',
    JWT_SECRET: TEST_SECRET,
    PERSIST_DEBOUNCE_MS: '5',
    ROOM_IDLE_TTL_MS: '0',
    ...options.env,
  });
  const logger = createLogger({ level: config.logLevel, nodeId: config.nodeId });
  const app = createApp({ config, logger, backplane: options.backplane, store: options.store });
  const { port } = await app.listen();
  return {
    app,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/collab`,
    close: () => app.close(),
  };
}

export async function issueToken(
  tenantId: string,
  role: 'editor' | 'viewer' = 'editor',
  name = 'Test User',
): Promise<string> {
  return (await new TokenService(TEST_SECRET).issue({ tenantId, name, role })).token;
}

export interface TestClient {
  doc: Y.Doc;
  provider: WebsocketProvider;
  destroy(): void;
}

export function connectClient(wsUrl: string, roomId: string, token: string): TestClient {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(wsUrl, roomId, doc, {
    params: { token },
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  return {
    doc,
    provider,
    destroy: () => {
      provider.destroy();
      doc.destroy();
    },
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Opens a raw socket and resolves with the close code the server sends. */
export function closeCodeFor(url: string, headers?: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on('close', (code) => resolve(code));
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', (err) => {
      if (!('code' in err)) reject(err);
    });
  });
}
