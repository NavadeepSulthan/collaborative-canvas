import { trace } from '@opentelemetry/api';
import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * Structured JSON logger. Every line emitted inside an active span carries
 * trace_id/span_id so logs can be joined with traces in Jaeger/Grafana.
 */
export function createLogger(options: { level: string; nodeId: string; pretty?: boolean }): Logger {
  return pino({
    level: options.level,
    base: { service: 'collab-server', node_id: options.nodeId },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: ['req.headers.authorization', 'token', '*.token'], censor: '[redacted]' },
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) return {};
      const { traceId, spanId } = span.spanContext();
      return { trace_id: traceId, span_id: spanId };
    },
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}
