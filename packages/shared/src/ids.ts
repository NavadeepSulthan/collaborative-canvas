import { z } from 'zod';

/** Lowercase, URL-safe identifier used for tenants and rooms (1–64 chars). */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const slugSchema = z.string().regex(SLUG_PATTERN, 'must be a lowercase slug (a-z, 0-9, -)');

export type Slug = z.infer<typeof slugSchema>;

/**
 * Rooms are always namespaced by tenant so two tenants can use the same room id
 * without ever sharing state. The tenant part is taken from the verified token, never the URL.
 */
export function roomKey(tenantId: string, roomId: string): string {
  return `${tenantId}/${roomId}`;
}
