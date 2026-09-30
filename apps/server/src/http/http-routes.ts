import type { IncomingMessage, ServerResponse } from 'node:http';
import { devTokenRequestSchema, type ApiError, type DevTokenResponse } from '@canvas/shared';
import { context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import type { Registry } from 'prom-client';
import type { AppConfig } from '../config.js';
import type { Logger } from '../observability/logger.js';
import { tracer } from '../observability/tracing.js';
import type { TokenService } from './token-service.js';

const MAX_JSON_BODY_BYTES = 4 * 1024;

export interface Readiness {
  ready: boolean;
  checks: Record<string, boolean>;
}

export interface HttpRoutesDeps {
  config: AppConfig;
  tokens: TokenService;
  metricsRegistry: Registry;
  readiness: () => Promise<Readiness>;
  logger: Logger;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Minimal REST surface: health probes, Prometheus metrics, and demo token issuance. */
export function createRequestHandler(deps: HttpRoutesDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const parentContext = propagation.extract(ROOT_CONTEXT, req.headers);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    const span = tracer.startSpan(
      `HTTP ${route}`,
      { attributes: { 'http.route': route } },
      parentContext,
    );

    void context
      .with(trace.setSpan(parentContext, span), () => handle(deps, req, res, url))
      .catch((error: unknown) => {
        if (error instanceof HttpError) {
          sendJson(res, error.status, {
            error: { code: error.code, message: error.message },
          } satisfies ApiError);
          return;
        }
        deps.logger.error({ err: error, route }, 'unhandled request error');
        sendJson(res, 500, {
          error: { code: 'internal', message: 'Internal server error' },
        } satisfies ApiError);
      })
      .finally(() => {
        span.setAttribute('http.status_code', res.statusCode);
        span.end();
      });
  };
}

async function handle(
  deps: HttpRoutesDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  applyCors(deps.config, req, res);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    res.writeHead(204).end();
    return;
  }

  switch (`${req.method} ${url.pathname}`) {
    case 'GET /healthz':
      sendJson(res, 200, { status: 'ok' });
      return;
    case 'GET /readyz': {
      const readiness = await deps.readiness();
      sendJson(res, readiness.ready ? 200 : 503, readiness);
      return;
    }
    case 'GET /metrics':
      res.writeHead(200, { 'Content-Type': deps.metricsRegistry.contentType });
      res.end(await deps.metricsRegistry.metrics());
      return;
    case 'POST /api/dev-token':
      await issueDevToken(deps, req, res);
      return;
    default:
      throw new HttpError(404, 'not_found', 'Route not found');
  }
}

async function issueDevToken(deps: HttpRoutesDeps, req: IncomingMessage, res: ServerResponse) {
  if (!deps.config.devTokensEnabled) {
    throw new HttpError(404, 'not_found', 'Route not found');
  }
  const parsed = devTokenRequestSchema.safeParse(await readJson(req));
  if (!parsed.success) {
    throw new HttpError(
      400,
      'invalid_request',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  const { tenantId, displayName, role } = parsed.data;
  const issued = await deps.tokens.issue({ tenantId, name: displayName, role });
  deps.logger.info({ tenant: tenantId, user_id: issued.user.id, role }, 'issued dev token');
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 201, {
    token: issued.token,
    expiresAt: issued.expiresAt.toISOString(),
    user: issued.user,
  } satisfies DevTokenResponse);
}

function applyCors(config: AppConfig, req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (!origin || !config.allowedOrigins.has(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, traceparent');
  res.setHeader('Access-Control-Max-Age', '600');
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Expected application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_JSON_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body is not valid JSON');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
