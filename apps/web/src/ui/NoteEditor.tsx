import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CanvasEngine } from '../canvas/canvas-engine';
import type { ShapeStore } from '../collab/shape-store';

interface NoteEditorProps {
  engine: CanvasEngine;
  store: ShapeStore;
  id: string;
  onClose(): void;
}

/**
 * A textarea overlaid on the note being edited. Every keystroke is applied as a minimal
 * Y.Text diff, so collaborators see typing live and concurrent edits merge.
 */
export function NoteEditor({ engine, store, id, onClose }: NoteEditorProps) {
  const [rect, setRect] = useState(() => engine.screenRectOf(id));
  const text = useSyncExternalStore(store.subscribe, () => store.get(id)?.text ?? '');
  const fill = store.get(id)?.fill;

  useEffect(() => {
    engine.setEditing(id);
    const unsubscribe = engine.subscribeViewport(() => setRect(engine.screenRectOf(id)));
    return () => {
      unsubscribe();
      engine.setEditing(null);
    };
  }, [engine, id]);

  if (!rect) return null;
  const scale = engine.viewport.scale;

  return (
    <textarea
      className="note-editor"
      aria-label="Note text"
      autoFocus
      value={text}
      onChange={(e) => store.setText(id, e.target.value)}
      onBlur={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        e.stopPropagation();
      }}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        background: fill,
        fontSize: 16 * scale,
        lineHeight: `${20 * scale}px`,
        padding: 10 * scale,
      }}
    />
  );
}
