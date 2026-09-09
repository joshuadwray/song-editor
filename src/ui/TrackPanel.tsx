import { Track } from '../model/project';

interface TrackPanelProps {
  track: Track;
  height: number;
  focused: boolean;
  onFocus: () => void;
  /** Live update — used continuously while a slider or name is being edited. */
  onChange: (patch: Partial<Track>) => void;
  /** Close the run of live updates as one undo step. */
  onCommit: () => void;
  onRemove: () => void;
}

/** The control strip to the left of each track, mirroring Audacity's layout. */
export function TrackPanel({
  track, height, focused, onFocus, onChange, onCommit, onRemove,
}: TrackPanelProps) {
  // Discrete controls are their own undo step; continuous ones coalesce into
  // one, so dragging a slider does not leave fifty entries in the history.
  const set = (patch: Partial<Track>) => {
    onChange(patch);
    onCommit();
  };

  return (
    <div
      className={`track-panel${focused ? ' focused' : ''}`}
      style={{ height }}
      onMouseDown={onFocus}
    >
      <div className="track-panel-top">
        <input
          className="track-name"
          value={track.name}
          onChange={(e) => onChange({ name: e.target.value })}
          onBlur={onCommit}
          aria-label="Track name"
        />
        <button type="button" className="track-close" onClick={onRemove} title="Close track">
          ×
        </button>
      </div>

      <div className="track-buttons">
        <button
          type="button"
          className={track.muted ? 'active' : ''}
          onClick={() => set({ muted: !track.muted })}
        >
          Mute
        </button>
        <button
          type="button"
          className={track.soloed ? 'active' : ''}
          onClick={() => set({ soloed: !track.soloed })}
        >
          Solo
        </button>
      </div>

      <label className="slider-row" title="Volume">
        <span>-</span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.01}
          value={track.gain}
          onChange={(e) => onChange({ gain: Number(e.target.value) })}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
          aria-label="Volume"
        />
        <span>+</span>
      </label>

      <label className="slider-row" title="Pan">
        <span>L</span>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={track.pan}
          onChange={(e) => onChange({ pan: Number(e.target.value) })}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
          aria-label="Pan"
        />
        <span>R</span>
      </label>
    </div>
  );
}
