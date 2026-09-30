function randomHex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * W3C `traceparent` for outgoing requests. The server continues this trace, so a
 * browser action and the server spans/logs it caused share one trace id.
 */
export function createTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

export function traceIdOf(traceparent: string): string {
  return traceparent.split('-')[1] ?? '';
}
