import type { SessionInfo } from '../collab/collab-session';

const KEY = 'collab-canvas:session';

/**
 * Keeps the session for this tab across reloads so the board still opens when the server is
 * unreachable (offline-first). sessionStorage is tab-scoped and cleared when the tab closes.
 */
export const sessionStore = {
  load(): SessionInfo | null {
    try {
      const raw = sessionStorage.getItem(KEY);
      if (!raw) return null;
      const info = JSON.parse(raw) as SessionInfo;
      return Date.parse(info.expiresAt) > Date.now() ? info : null;
    } catch {
      return null;
    }
  },
  save(info: SessionInfo): void {
    sessionStorage.setItem(KEY, JSON.stringify(info));
  },
  clear(): void {
    sessionStorage.removeItem(KEY);
  },
};
