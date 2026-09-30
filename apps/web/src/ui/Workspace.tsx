import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CanvasEngine, type Tool } from '../canvas/canvas-engine';
import { CollabSession, type SessionInfo } from '../collab/collab-session';
import { FILL_COLORS } from './colors';
import { NoteEditor } from './NoteEditor';
import { PresenceList } from './PresenceList';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { useKeyboardShortcuts } from './use-keyboard-shortcuts';

interface WorkspaceProps {
  info: SessionInfo;
  onLeave(): void;
}

/** Owns the CollabSession lifecycle (created on mount, destroyed on unmount). */
export function Workspace({ info, onLeave }: WorkspaceProps) {
  const [session, setSession] = useState<CollabSession | null>(null);

  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      const created = new CollabSession(info);
      setSession(created);
      return () => {
        created.destroy();
        setSession(null);
      };
    },
    [info],
  );

  return (
    <div className="workspace" ref={attach}>
      {session && <Board session={session} onLeave={onLeave} />}
    </div>
  );
}

function Board({ session, onLeave }: { session: CollabSession; onLeave(): void }) {
  const [engine, setEngine] = useState<CanvasEngine | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<string[]>([]);
  const [fill, setFill] = useState<string>(FILL_COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fillRef = useRef(fill);
  const state = useSyncExternalStore(session.subscribe, session.getState);

  useEffect(() => {
    fillRef.current = fill;
  }, [fill]);

  const attachCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      const created = new CanvasEngine(canvas, session.shapes, session.presence, {
        readOnly: session.readOnly,
        getFill: () => fillRef.current,
        onSelectionChange: setSelection,
        onToolChange: setTool,
        onEditNote: setEditingId,
        onError: setNotice,
      });
      setEngine(created);
      return () => {
        created.destroy();
        setEngine(null);
      };
    },
    [session],
  );

  useKeyboardShortcuts(engine, session);

  const changeFill = (color: string) => {
    setFill(color);
    if (engine && selection.length > 0 && !session.readOnly)
      session.shapes.setFill(selection, color);
  };

  return (
    <>
      <header className="topbar">
        {engine && (
          <Toolbar
            engine={engine}
            session={session}
            tool={tool}
            fill={fill}
            hasSelection={selection.length > 0}
            onFill={changeFill}
            onError={setNotice}
          />
        )}
        <PresenceList session={session} />
        <button className="ghost" onClick={onLeave}>
          Leave
        </button>
      </header>

      {state.status === 'rejected' && (
        <div className="banner error" role="alert">
          Connection rejected: {state.rejectionReason}.{' '}
          <button onClick={onLeave}>Sign in again</button>
        </div>
      )}

      {notice && (
        <div className="banner" role="status">
          {notice}. <button onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div className="stage">
        <canvas
          ref={attachCanvas}
          className="board"
          data-testid="board"
          tabIndex={0}
          aria-label="Canvas"
        />
        {engine && editingId && (
          <NoteEditor
            key={editingId}
            engine={engine}
            store={session.shapes}
            id={editingId}
            onClose={() => setEditingId(null)}
          />
        )}
      </div>

      {engine && (
        <StatusBar
          engine={engine}
          session={session}
          state={state}
          selectionCount={selection.length}
        />
      )}
    </>
  );
}
