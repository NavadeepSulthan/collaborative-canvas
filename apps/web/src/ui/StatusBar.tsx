import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CanvasEngine } from '../canvas/canvas-engine';
import type { FrameStatsSnapshot } from '../canvas/frame-stats';
import type { CollabSession, SessionState } from '../collab/collab-session';
import { traceIdOf } from '../observability/trace-context';

interface StatusBarProps {
  engine: CanvasEngine;
  session: CollabSession;
  state: SessionState;
  selectionCount: number;
}

const STATUS_LABEL: Record<SessionState['status'], string> = {
  connecting: 'Connecting…',
  connected: 'Live',
  disconnected: 'Offline — edits saved locally',
  rejected: 'Rejected',
};

export function StatusBar({ engine, session, state, selectionCount }: StatusBarProps) {
  useSyncExternalStore(session.shapes.subscribe, session.shapes.getRevision);
  const [stats, setStats] = useState<FrameStatsSnapshot>(() => engine.getStats());

  useEffect(() => {
    const timer = setInterval(() => setStats(engine.getStats()), 500);
    return () => clearInterval(timer);
  }, [engine]);

  const { user } = session.info;
  return (
    <footer className="statusbar">
      <span className={`status status-${state.status}`} data-testid="connection-status">
        ● {STATUS_LABEL[state.status]}
        {state.status === 'connected' && !state.synced && ' (syncing)'}
      </span>
      <span>
        {user.tenantId} / {session.info.roomId}
      </span>
      <span className="badge">{user.role}</span>
      <span data-testid="shape-count">
        {session.shapes.size} {session.shapes.size === 1 ? 'shape' : 'shapes'}
      </span>
      <span>{selectionCount} selected</span>
      <span title="Frames per second while animating · 95th percentile frame time · shapes repainted in the last frame (unchanged areas come from the cached layer)">
        {stats.fps} fps · p95 {stats.p95FrameMs} ms · {stats.drawnShapes} repainted
      </span>
      <span className="muted" title="W3C trace id for this connection (search it in Jaeger)">
        trace {traceIdOf(session.traceparent).slice(0, 12)}
      </span>
      <span className="muted">{session.info.serverUrl}</span>
    </footer>
  );
}
