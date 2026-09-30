import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const DEV_JWT_SECRET = 'dev-only-secret-change-me-dev-only-secret';

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(0).max(65_535).default(4000),
    NODE_ID: z.string().min(1).optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
    JWT_SECRET: z.string().min(32).optional(),
    AUTH_DEV_TOKENS: booleanFromEnv.optional(),
    REDIS_URL: z.string().url().optional(),
    DATABASE_URL: z.string().url().optional(),
    PERSIST_DEBOUNCE_MS: z.coerce.number().int().min(0).default(250),
    COMPACTION_THRESHOLD: z.coerce.number().int().min(1).default(50),
    ROOM_IDLE_TTL_MS: z.coerce.number().int().min(0).default(30_000),
    ANTI_ENTROPY_INTERVAL_MS: z.coerce.number().int().min(0).default(15_000),
    BROADCAST_INTERVAL_MS: z.coerce.number().int().min(0).default(25),
    // A reconnecting client sends its whole missing diff in one frame, so this must fit a full document.
    MAX_MESSAGE_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(32 * 1024 * 1024),
    OTEL_ENABLED: booleanFromEnv.default(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'required in production' });
    }
  });

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  nodeId: string;
  logLevel: string;
  allowedOrigins: ReadonlySet<string>;
  jwtSecret: string;
  devTokensEnabled: boolean;
  redisUrl: string | undefined;
  databaseUrl: string | undefined;
  persistDebounceMs: number;
  compactionThreshold: number;
  roomIdleTtlMs: number;
  antiEntropyIntervalMs: number;
  broadcastIntervalMs: number;
  maxMessageBytes: number;
  otelEnabled: boolean;
}

/** Parses and validates environment variables once at startup; fails fast on bad config. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  const env = parsed.data;
  return {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    nodeId: env.NODE_ID ?? `${hostname()}-${randomBytes(3).toString('hex')}`,
    logLevel: env.LOG_LEVEL,
    allowedOrigins: new Set(
      env.ALLOWED_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
    jwtSecret: env.JWT_SECRET ?? DEV_JWT_SECRET,
    devTokensEnabled: env.AUTH_DEV_TOKENS ?? env.NODE_ENV !== 'production',
    redisUrl: env.REDIS_URL,
    databaseUrl: env.DATABASE_URL,
    persistDebounceMs: env.PERSIST_DEBOUNCE_MS,
    compactionThreshold: env.COMPACTION_THRESHOLD,
    roomIdleTtlMs: env.ROOM_IDLE_TTL_MS,
    antiEntropyIntervalMs: env.ANTI_ENTROPY_INTERVAL_MS,
    broadcastIntervalMs: env.BROADCAST_INTERVAL_MS,
    maxMessageBytes: env.MAX_MESSAGE_BYTES,
    otelEnabled: env.OTEL_ENABLED,
  };
}
