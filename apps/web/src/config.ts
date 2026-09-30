import { COLLAB_PATH_PREFIX } from '@canvas/shared';

/**
 * Collaboration servers the user may pick from. Listing two nodes lets you open one tab per
 * node and watch edits cross the Redis backplane. Only allow-listed URLs are ever used, so a
 * crafted link can't redirect a token to a foreign server.
 */
export const COLLAB_SERVERS: readonly string[] = (
  import.meta.env.VITE_COLLAB_SERVERS ?? 'http://localhost:4000'
)
  .split(',')
  .map((url) => url.trim().replace(/\/$/, ''))
  .filter(Boolean);

export function toWebSocketUrl(httpUrl: string): string {
  return `${httpUrl.replace(/^http/, 'ws')}${COLLAB_PATH_PREFIX}`;
}
