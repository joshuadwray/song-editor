/**
 * The timeline: one column per 8-count, with lanes for sections, the counts,
 * the music and her notes.
 *
 * Laid out by 8-count rather than by seconds, which is how she thinks about the
 * piece: every 8-count is the same width even across a tempo change, so a
 * phrase always looks like a phrase. Time only matters inside a column.
 *
 * Columns are memoized and know nothing about the playhead, so playback
 * re-renders just the playhead line, not fifty canvases sixty times a second.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { PALETTE, SECTION_COLORS } from '../../../choreo/app.config';
import type { Peaks } from '../../waveform/peaks';
import { ecLength, ecRange, positionAt, type GridSegment } from '../model/grid';
import { noteAt, type Piece } from '../model/piece';
import { ecLabel } from './format';
import { drawColumn } from './waveform';

interface Props {
  piece: Piece;
  peaks: Peaks;
  duration: number;
  span: { first: number; last: number };
  colW: number;
  time: number;
  playing: boolean;
  follow: boolean;
  onStopFollowing: () => void;
  selLo: number;
  selHi: number;
  currentEc: number;
  onSelect: (ec: number, extend: boolean, jump: boolean) => void;
  onSeek: (time: number) => void;
  onNote: (ec: number, text: string) => void;
}

/** Bpm in force at the start of an 8-count. */
function bpmAt(grid: GridSegment[], time: number): number {
  return grid[positionAt(grid, time + 1e-4).segment].bpm;
}

export function Timeline(p: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const grid = p.piece.grid;
  const first = p.span.first;
  const count = p.span.last - first + 1;

  const xOf = useCallback((t: number) => {
    const pos = positionAt(grid, t);
    const r = ecRange(grid, pos.ec);
    return (pos.ec - first) * p.colW + (p.colW * (t - r.start)) / ecLength(grid[pos.segment].bpm);
  }, [grid, first, p.colW]);

  const ecAtX = (clientX: number) => {
    const rect = contentRef.current!.getBoundingClientRect();
    const x = clientX - rect.left;
    return { ec: Math.min(p.span.last, Math.max(first, first + Math.floor(x / p.colW))), within: (x % p.colW) / p.colW };
  };

  // Keep the playhead in view while playing, page-turn style, so the column
  // she is reading does not slide under her eyes on every frame.
  const playX = xOf(p.time);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !p.follow) return;
    const left = el.scrollLeft, w = el.clientWidth;
    if (playX < left + 40 || playX > left + w * 0.85) {
      // Land on a column boundary, so no 8-count is left cut in half.
      el.scrollLeft = Math.max(0, Math.floor((playX - w * 0.15) / p.colW) * p.colW);
    }
  }, [playX, p.follow, p.colW]);

  // A plain mouse wheel scrolls the timeline sideways; that is the only way it scrolls.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.ctrlKey) {
        if ((e.target as HTMLElement).closest('textarea')) return;
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
      p.onStopFollowing();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [p.onStopFollowing]);

  // Drag across the 8-count numbers to select a block.
  const dragging = useRef(false);
  const onRulerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
    p.onSelect(ecAtX(e.clientX).ec, e.shiftKey, true);
  };
  const onRulerMove = (e: React.PointerEvent) => {
    if (dragging.current) p.onSelect(ecAtX(e.clientX).ec, true, false);
  };
  const onRulerUp = () => { dragging.current = false; };

  const onWaveClick = (e: React.MouseEvent) => {
    const { ec, within } = ecAtX(e.clientX);
    const r = ecRange(grid, ec);
    const t = r.start + within * ecLength(bpmAt(grid, r.start));
    p.onSelect(ec, e.shiftKey, false);
    p.onSeek(Math.max(0, Math.min(p.duration - 0.01, Math.min(t, r.end - 0.001))));
  };

  const ecs: number[] = [];
  for (let i = 0; i < count; i += 1) ecs.push(first + i);

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="tl-labels" aria-hidden>
        <div className="tl-l-sections">Sections</div>
        <div className="tl-l-ruler">8-counts</div>
        <div className="tl-l-wave">Music</div>
        <div className="tl-l-notes">Notes</div>
      </div>
      <div className="tl-scroll" ref={scrollRef} onPointerDown={(e) => {
        // Grabbing the scrollbar is a manual scroll too.
        if (e.target === scrollRef.current) p.onStopFollowing();
      }}>
        <div className="tl-content" ref={contentRef} style={{ width: count * p.colW }}>
          <div className="tl-sections">
            {p.piece.sections.map((s) => (
              <button key={s.id} className="tl-section"
                style={{
                  left: (s.startEc - first) * p.colW, width: (s.endEc - s.startEc + 1) * p.colW,
                  background: SECTION_COLORS[s.color % SECTION_COLORS.length],
                }}
                onClick={() => { p.onSelect(s.startEc, false, true); p.onSelect(s.endEc, true, false); }}>
                {s.name}
              </button>
            ))}
          </div>
          <div className="tl-ruler" onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp}>
            {ecs.map((ec) => (
              <RulerCell key={ec} ec={ec} colW={p.colW} selected={ec >= p.selLo && ec <= p.selHi} current={ec === p.currentEc} />
            ))}
          </div>
          <div className="tl-wave" onClick={onWaveClick}>
            {ecs.map((ec) => {
              const r = ecRange(grid, ec);
              return (
                <WaveCell key={ec} peaks={p.peaks} colW={p.colW} t0={r.start}
                  t1={r.start + ecLength(bpmAt(grid, r.start))} end={r.end}
                  selected={ec >= p.selLo && ec <= p.selHi} />
              );
            })}
          </div>
          <div className="tl-notes">
            {ecs.map((ec) => (
              <NoteCell key={ec} ec={ec} colW={p.colW} text={noteAt(p.piece, ec)}
                selected={ec >= p.selLo && ec <= p.selHi} onNote={p.onNote} onSelect={p.onSelect} />
            ))}
          </div>
          <div className="tl-playhead" style={{ transform: `translateX(${playX}px)` }} />
        </div>
      </div>
    </section>
  );
}

const RulerCell = memo(function RulerCell({ ec, colW, selected, current }: { ec: number; colW: number; selected: boolean; current: boolean }) {
  return (
    <div className={`tl-cell ruler-cell ${selected ? 'sel' : ''} ${current ? 'cur' : ''} ${ec < 0 ? 'pre' : ''}`}
      style={{ width: colW }} data-ec={ec}>
      <span className="ec-num">{ec < 0 ? 'intro' : ecLabel(ec)}</span>
      <span className="ticks" aria-hidden>
        {[1, 2, 3, 4, 5, 6, 7, 8].map((c) => <i key={c} className={c === 1 ? 'one' : c === 5 ? 'five' : ''} />)}
      </span>
    </div>
  );
});

const WaveCell = memo(function WaveCell(
  { peaks, colW, t0, t1, end, selected }: { peaks: Peaks; colW: number; t0: number; t1: number; end: number; selected: boolean },
) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawColumn(ref.current, peaks, t0, t1, end, { wave: PALETTE.waveformPlayed, gap: 'rgba(0,0,0,0.35)' });
  }, [peaks, colW, t0, t1, end]);
  return (
    <div className={`tl-cell wave-cell ${selected ? 'sel' : ''}`} style={{ width: colW }}>
      <canvas ref={ref} />
    </div>
  );
});

const NoteCell = memo(function NoteCell(
  { ec, colW, text, selected, onNote, onSelect }:
  { ec: number; colW: number; text: string; selected: boolean; onNote: (ec: number, t: string) => void; onSelect: Props['onSelect'] },
) {
  return (
    <div className={`tl-cell note-cell ${selected ? 'sel' : ''}`} style={{ width: colW }}>
      <textarea value={text} placeholder="+ steps" spellCheck={false} data-ec={ec}
        aria-label={`Notes for 8-count ${ecLabel(ec)}`}
        onFocus={() => onSelect(ec, false, false)}
        onChange={(e) => onNote(ec, e.target.value)} />
    </div>
  );
});
