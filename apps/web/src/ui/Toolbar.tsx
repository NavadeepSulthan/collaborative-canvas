import { useState } from 'react';
import type { CanvasEngine, Tool } from '../canvas/canvas-engine';
import type { CollabSession } from '../collab/collab-session';
import { BoardFullError } from '../collab/shape-store';
import { generateShapes } from '../dev/stress-test';
import { FILL_COLORS } from './colors';

const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'select', label: 'Select', key: 'V' },
  { id: 'pan', label: 'Pan', key: 'H' },
  { id: 'rect', label: 'Rectangle', key: 'R' },
  { id: 'ellipse', label: 'Ellipse', key: 'O' },
  { id: 'note', label: 'Note', key: 'N' },
];

interface ToolbarProps {
  engine: CanvasEngine;
  session: CollabSession;
  tool: Tool;
  fill: string;
  hasSelection: boolean;
  onFill(color: string): void;
  onError(message: string): void;
}

export function Toolbar({
  engine,
  session,
  tool,
  fill,
  hasSelection,
  onFill,
  onError,
}: ToolbarProps) {
  const [benchmark, setBenchmark] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const readOnly = session.readOnly;

  const addShapes = (count: number) => {
    try {
      session.shapes.createMany(generateShapes(count, engine.visibleWorldRect()));
    } catch (error) {
      if (!(error instanceof BoardFullError)) throw error;
      onError(error.message);
    }
  };

  const runBenchmark = async () => {
    setBenchmark('running…');
    const result = await engine.runBenchmark(3000);
    setBenchmark(
      `${result.fps} fps · p95 ${result.p95FrameMs} ms · ${result.drawnShapes} repainted`,
    );
  };

  return (
    <nav className="toolbar" aria-label="Tools">
      <div className="group" role="radiogroup" aria-label="Tool">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            role="radio"
            aria-checked={tool === t.id}
            className={tool === t.id ? 'active' : ''}
            disabled={readOnly && t.id !== 'select' && t.id !== 'pan'}
            title={`${t.label} (${t.key})`}
            onClick={() => engine.setTool(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="group" aria-label="Fill color">
        {FILL_COLORS.map((color) => (
          <button
            key={color}
            className={`swatch ${fill === color ? 'active' : ''}`}
            style={{ background: color }}
            aria-label={`Fill ${color}`}
            disabled={readOnly}
            onClick={() => onFill(color)}
          />
        ))}
      </div>

      <div className="group">
        <button disabled={readOnly} title="Undo (⌘Z)" onClick={() => session.undoManager.undo()}>
          Undo
        </button>
        <button disabled={readOnly} title="Redo (⇧⌘Z)" onClick={() => session.undoManager.redo()}>
          Redo
        </button>
        <button
          disabled={readOnly || !hasSelection}
          title="Delete (⌫)"
          onClick={() => engine.deleteSelection()}
        >
          Delete
        </button>
      </div>

      <div className="group">
        <button title="Zoom out (-)" onClick={() => engine.zoomBy(1 / 1.2)}>
          −
        </button>
        <button title="Zoom in (+)" onClick={() => engine.zoomBy(1.2)}>
          +
        </button>
        <button title="Zoom to fit (⇧1)" onClick={() => engine.zoomToFit()}>
          Fit
        </button>
      </div>

      <details className="group perf">
        <summary>Dev tools</summary>
        <div className="perf-menu">
          <label>
            <input
              type="checkbox"
              checked={offline}
              onChange={(e) => {
                setOffline(e.target.checked);
                session.setNetworkEnabled(!e.target.checked);
              }}
            />{' '}
            Simulate offline
          </label>
          <button disabled={readOnly} onClick={() => addShapes(1000)}>
            +1,000 shapes
          </button>
          <button disabled={readOnly} onClick={() => addShapes(5000)}>
            +5,000 shapes
          </button>
          <button onClick={runBenchmark}>Run 3s pan benchmark</button>
          <button
            disabled={readOnly}
            onClick={() =>
              window.confirm('Delete every shape on this board for everyone?') &&
              session.shapes.clear()
            }
          >
            Clear board
          </button>
          {benchmark && <output>{benchmark}</output>}
        </div>
      </details>
    </nav>
  );
}
