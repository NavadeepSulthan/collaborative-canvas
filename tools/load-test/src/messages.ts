export type ClientRole = 'editor' | 'observer';

export interface ClientSpec {
  index: number;
  room: string;
  role: ClientRole;
}

/** Canonical JSON of each shape keyed by id, for convergence checks. */
export type RoomState = Record<string, string>;

export function sameState(expected: RoomState, actual: RoomState): boolean {
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length && keys.every((k) => expected[k] === actual[k]);
}

export interface EditorReport {
  editsSent: number;
  framesIn: number;
  bytesIn: number;
  framesOut: number;
  bytesOut: number;
  disconnects: number;
  scheduleLagMs: number[];
  ownShapes: Record<string, RoomState>;
}

export interface ObserverReport {
  latenciesMs: number[];
  /** Per observer: ms after the last edit was sent until its state matched; -1 = never. */
  convergeMs: number[];
  framesIn: number;
  bytesIn: number;
  disconnects: number;
  /** One entry per observer client. */
  states: { room: string; state: RoomState }[];
}

export type ToWorker =
  | {
      type: 'init';
      wsUrl: string;
      token: string;
      clients: ClientSpec[];
      editsPerClient: number;
      rate: number;
      cursorHz: number;
    }
  | { type: 'go'; startAt: number }
  | {
      type: 'finish';
      expected: Record<string, RoomState>;
      editsFinishedAt: number;
      maxWaitMs: number;
    };

export type FromWorker =
  | { type: 'ready'; connected: number; failed: number; connectMs: number[] }
  | { type: 'progress'; edits: number }
  | { type: 'edits-done'; report: EditorReport }
  | { type: 'final'; report: ObserverReport };
