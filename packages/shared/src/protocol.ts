/** Path prefix for collaboration sockets: `ws(s)://host/collab/:roomId?token=...`. */
export const COLLAB_PATH_PREFIX = '/collab';

/** y-websocket wire protocol message types (first varuint of every frame). */
export const MessageType = {
  Sync: 0,
  Awareness: 1,
  Auth: 2,
  QueryAwareness: 3,
} as const;

/** Application close codes (4000–4999 range is reserved for applications). */
export const CloseCode = {
  ServiceRestart: 1012,
  TryAgainLater: 1013,
  PolicyViolation: 1008,
  MessageTooBig: 1009,
  BadRequest: 4400,
  Unauthorized: 4401,
  Forbidden: 4403,
} as const;

/** Close codes after which the client must not auto-reconnect with the same credentials. */
export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  CloseCode.BadRequest,
  CloseCode.Unauthorized,
  CloseCode.Forbidden,
]);
