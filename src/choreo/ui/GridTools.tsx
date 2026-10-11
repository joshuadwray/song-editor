/**
 * Fixing the grid: tempo, where count 1 falls, and tempo changes at splices.
 *
 * Everything acts on the tempo section under the playhead, which for most
 * songs is the only one.
 */

import { useEffect, useRef, useState } from 'react';
import { tapTempo, type GridSegment } from '../model/grid';
import { formatBpm } from './format';

interface Props {
  segment: GridSegment;
  segIndex: number;
  segCount: number;
  onCountOne: () => void;
  onStartHere: () => void;
  canStartHere: boolean;
  onSplit: () => void;
  onRemoveSegment: () => void;
  onNudge: (seconds: number) => void;
  onBpm: (bpm: number) => void;
}

const NUDGE = 0.01;

export function GridTools(p: Props) {
  const [draft, setDraft] = useState(formatBpm(p.segment.bpm));
  const [more, setMore] = useState(false);
  const taps = useRef<number[]>([]);
  const [tapCount, setTapCount] = useState(0);

  useEffect(() => setDraft(formatBpm(p.segment.bpm)), [p.segment.bpm]);

  // The menu closes on any click outside it, or Escape, like every other menu.
  const moreRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!more) return;
    const onDown = (e: PointerEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMore(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMore(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [more]);

  const commitDraft = () => {
    const v = Number(draft);
    if (Number.isFinite(v) && v > 0) p.onBpm(Math.round(v * 100) / 100);
    else setDraft(formatBpm(p.segment.bpm));
  };

  const tap = () => {
    const now = performance.now() / 1000;
    const list = taps.current;
    // A pause of two seconds starts a fresh tempo.
    if (list.length && now - list[list.length - 1] > 2) list.length = 0;
    list.push(now);
    if (list.length > 16) list.shift();
    setTapCount(list.length);
    const bpm = tapTempo(list);
    if (bpm) p.onBpm(Math.round(bpm * 10) / 10);
  };

  return (
    <div className="grid-tools">
      {p.segCount > 1 && (
        <span className="seg-label" title="This song changes tempo; these controls apply to the part under the playhead">
          Tempo part {p.segIndex + 1}/{p.segCount}
        </span>
      )}
      <label className="bpm">
        <input value={draft} inputMode="decimal" aria-label="Beats per minute"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        BPM
      </label>
      <button onClick={() => p.onBpm(p.segment.bpm / 2)} title="Count at half speed">÷2</button>
      <button onClick={() => p.onBpm(p.segment.bpm * 2)} title="Count at double speed">×2</button>
      <button onClick={tap} title="Tap along with the beat, four times or more">
        Tap{tapCount > 0 && tapCount < 4 ? ` (${4 - tapCount})` : ''}
      </button>
      <button className="primary" onClick={p.onCountOne} title="Put count 1 on the playhead, keeping the 8-count numbers (1 key)">
        Count 1 here
      </button>
      <span className="nudge" role="group" aria-label="Nudge the grid">
        <button onClick={() => p.onNudge(-NUDGE)} title="Move the counts 10 ms earlier" aria-label="Nudge earlier">◂</button>
        <span>nudge</span>
        <button onClick={() => p.onNudge(NUDGE)} title="Move the counts 10 ms later" aria-label="Nudge later">▸</button>
      </span>
      <span className="more" ref={moreRef}>
        <button onClick={() => setMore((v) => !v)} aria-expanded={more}>More ▾</button>
        {more && (
          <span className="more-menu" onClick={() => setMore(false)}>
            <button onClick={p.onStartHere} disabled={!p.canStartHere}>Start counting here (skip the intro)</button>
            <button onClick={p.onSplit}>New tempo from here (for a splice)</button>
            <button onClick={p.onRemoveSegment} disabled={p.segIndex === 0}>Remove this tempo change</button>
          </span>
        )}
      </span>
    </div>
  );
}
