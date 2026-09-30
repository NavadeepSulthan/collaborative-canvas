/** Keys of the shared Y.Doc. Changing these is a data migration. */
export const DOC_KEYS = {
  shapes: 'shapes',
} as const;

export const SHAPE_KINDS = ['rect', 'ellipse', 'note'] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

/** Plain (non-CRDT) view of a shape, used by renderers and tests. */
export interface Shape {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  z: number;
  text: string;
}

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

export interface Point {
  x: number;
  y: number;
}

/** Awareness state each client broadcasts. Cursor is in world (canvas) coordinates. */
export interface PresenceState {
  user: PresenceUser;
  cursor: Point | null;
  selection: string[];
}
