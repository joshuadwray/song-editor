import { formatTime } from '../waveform/draw';
import type { Tool } from './Timeline';

interface ToolbarProps {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  isPlaying: boolean;
  canPlay: boolean;
  playhead: number;
  selectionStart: number | null;
  selectionEnd: number | null;
  onPlay: () => void;
  onStop: () => void;
  onSkipStart: () => void;
  onSkipEnd: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
}

export function Toolbar(props: ToolbarProps) {
  const {
    tool,
    onToolChange,
    isPlaying,
    canPlay,
    playhead,
    selectionStart,
    selectionEnd,
    onPlay,
    onStop,
    onSkipStart,
    onSkipEnd,
    onZoomIn,
    onZoomOut,
    onZoomFit,
  } = props;

  const hasRange = selectionStart !== null && selectionEnd !== null && selectionEnd > selectionStart;

  return (
    <div className="toolbar">
      <div className="toolbar-group tools">
        <button
          type="button"
          className={tool === 'select' ? 'active' : ''}
          onClick={() => onToolChange('select')}
          title="Selection tool — drag to select audio (F1)"
        >
          I
        </button>
        <button
          type="button"
          className={tool === 'shift' ? 'active' : ''}
          onClick={() => onToolChange('shift')}
          title="Time Shift tool — drag audio along the timeline (F5)"
        >
          ↔
        </button>
      </div>

      <div className="toolbar-group transport">
        <button type="button" onClick={onSkipStart} title="Skip to start (Home)">
          ⏮
        </button>
        <button
          type="button"
          onClick={onPlay}
          disabled={!canPlay || isPlaying}
          title="Play (Space)"
          className="play"
        >
          ▶
        </button>
        <button type="button" onClick={onStop} disabled={!isPlaying} title="Stop (Space)">
          ⏹
        </button>
        <button type="button" onClick={onSkipEnd} title="Skip to end (End)">
          ⏭
        </button>
      </div>

      <div className="toolbar-group">
        <button type="button" onClick={onZoomOut} title="Zoom out (Ctrl+3)">
          –
        </button>
        <button type="button" onClick={onZoomIn} title="Zoom in (Ctrl+1)">
          +
        </button>
        <button type="button" onClick={onZoomFit} title="Fit project to window (Ctrl+2)">
          Fit
        </button>
      </div>

      <div className="toolbar-group readout">
        <span className="readout-label">Position</span>
        <span className="readout-value">{formatTime(playhead, true)}</span>
        <span className="readout-label">Selection</span>
        <span className="readout-value">
          {hasRange
            ? `${formatTime(selectionStart!, true)} – ${formatTime(selectionEnd!, true)}  (${(
                selectionEnd! - selectionStart!
              ).toFixed(3)}s)`
            : selectionStart !== null
              ? formatTime(selectionStart, true)
              : '—'}
        </span>
      </div>
    </div>
  );
}
