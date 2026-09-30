import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

export const tracer = trace.getTracer('collab-server');

/**
 * Starts the OpenTelemetry SDK. Exporter endpoint comes from the standard
 * OTEL_EXPORTER_OTLP_ENDPOINT env var (e.g. Jaeger's OTLP HTTP port 4318).
 */
export function startTracing(serviceName: string): () => Promise<void> {
  const sdk = new NodeSDK({ serviceName, traceExporter: new OTLPTraceExporter() });
  sdk.start();
  return () => sdk.shutdown();
}

/** Runs `fn` inside a span, recording exceptions and always ending the span. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
