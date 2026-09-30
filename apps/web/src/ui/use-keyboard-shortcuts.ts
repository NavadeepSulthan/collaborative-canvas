import { useEffect } from 'react';
import type { CanvasEngine, Tool } from '../canvas/canvas-engine';
import type { CollabSession } from '../collab/collab-session';

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  h: 'pan',
  r: 'rect',
  o: 'ellipse',
  n: 'note',
};

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export function useKeyboardShortcuts(engine: CanvasEngine | null, session: CollabSession): void {
  useEffect(() => {
    if (!engine) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (key === ' ') {
        e.preventDefault();
        engine.setSpacePan(true);
      } else if (mod && key === 'z') {
        e.preventDefault();
        if (session.readOnly) return;
        if (e.shiftKey) session.undoManager.redo();
        else session.undoManager.undo();
      } else if (mod && key === 'y') {
        e.preventDefault();
        if (!session.readOnly) session.undoManager.redo();
      } else if (mod && key === 'a') {
        e.preventDefault();
        engine.selectAll();
      } else if (key === 'delete' || key === 'backspace') {
        engine.deleteSelection();
      } else if (key === 'escape') {
        engine.setSelection([]);
        engine.setTool('select');
      } else if (key === '=' || key === '+') {
        engine.zoomBy(1.2);
      } else if (key === '-') {
        engine.zoomBy(1 / 1.2);
      } else if (e.shiftKey && e.code === 'Digit1') {
        engine.zoomToFit();
      } else if (!mod && TOOL_KEYS[key]) {
        engine.setTool(TOOL_KEYS[key]);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') engine.setSpacePan(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [engine, session]);
}
