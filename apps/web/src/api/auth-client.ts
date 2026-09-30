import {
  apiErrorSchema,
  devTokenResponseSchema,
  type DevTokenRequest,
  type DevTokenResponse,
} from '@canvas/shared';
import { createTraceparent } from '../observability/trace-context';

/** Requests a demo access token. Responses are validated against the shared contract. */
export async function requestDevToken(
  serverUrl: string,
  request: DevTokenRequest,
): Promise<DevTokenResponse> {
  const response = await fetch(`${serverUrl}/api/dev-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', traceparent: createTraceparent() },
    body: JSON.stringify(request),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(body);
    throw new Error(
      error.success ? error.data.error.message : `Request failed (${response.status})`,
    );
  }
  return devTokenResponseSchema.parse(body);
}
