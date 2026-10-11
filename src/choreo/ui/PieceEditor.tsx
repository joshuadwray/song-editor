/**
 * The piece editor: the count display, the block panel and the timeline,
 * around one piece and one song.
 *
 * Edits go through a single `edit()` so every change is undoable and
 * autosaved the same way. Typing a note is coalesced into one undo step per
 * 8-count, or undo would rewind her notes a letter at a time.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hasOpfs } from '../../storage/opfs';
import {
  canRedo, canUndo, commit, amend, initHistory, redo, undo, type History,
} from '../../model/history';
import { Player } from '../audio/player';
import {
  ecRange, ecSpan, nudge, positionAt, removeSegment, setBpm, setCountOne, splitAt,
  startNumberingAt, type GridSegment,
} from '../model/grid';
import {
  addSection, removeSection, sectionAt, setNote, updateSection, type Piece,
} from '../model/piece';
import { savePiece } from '../storage';
import type { LoadedPiece } from './App';
import { BlockPanel } from './BlockPanel';
import { CountDisplay } from './CountDisplay';
import { formatBpm, formatTime } from './format';
import { GridTools } from './GridTools';
import { Timeline } from './Timeline';

export type SaveState = 'saved' | 'unsaved' | 'saving' | 'unavailable';

export interface Selection {
  anchor: number;
  head: number;
}

const NOTE_COALESCE_MS = 1500;

export function PieceEditor({ loaded, onClose }: { loaded: LoadedPiece; onClose: () => void }) {
  const [history, setHistory] = useState<History<Piece>>(() => initHistory(loaded.piece));
  const piece = history.present;
  const [name, setName] = useState(loaded.name);
  const [saveState, setSaveState] = useState<SaveState>(hasOpfs() ? 'saved' : 'unavailable');
  const [saveError, setSaveError] = useState<string | null>(null);

  const player = useMemo(() => new Player(), []);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [selection, setSelection] = useState<Selection>(() => {
    const ec = Math.max(0, positionAt(loaded.piece.grid, 0).ec);
    return { anchor: ec, head: ec };
  });
  const [loopOn, setLoopOn] = useState(false);
  const [clickOn, setClickOn] = useState(!loaded.piece.gridConfirmed);
  const [colW, setColW] = useState(120);
  const [follow, setFollow] = useState(true);

  const grid = piece.grid;
  const duration = loaded.buffer.duration;
  const span = useMemo(() => ecSpan(grid, duration), [grid, duration]);
  const pos = useMemo(() => positionAt(grid, time), [grid, time]);
  const selLo = Math.min(selection.anchor, selection.head);
  const selHi = Math.max(selection.anchor, selection.head);

  // ------------------------------------------------------------------ editing

  const lastNoteEdit = useRef<{ ec: number; at: number } | null>(null);

  const edit = useCallback((fn: (p: Piece) => Piece) => {
    lastNoteEdit.current = null;
    setHistory((h) => commit(h, fn(h.present)));
  }, []);

  const editNote = useCallback((ec: number, text: string) => {
    const now = Date.now();
    const last = lastNoteEdit.current;
    const coalesce = last && last.ec === ec && now - last.at < NOTE_COALESCE_MS;
    lastNoteEdit.current = { ec, at: now };
    setHistory((h) => (coalesce ? amend(h, setNote(h.present, ec, text)) : commit(h, setNote(h.present, ec, text))));
  }, []);

  const editGrid = useCallback((fn: (g: GridSegment[]) => GridSegment[]) => {
    edit((p) => ({ ...p, grid: fn(p.grid) }));
  }, [edit]);

  const doUndo = useCallback(() => { lastNoteEdit.current = null; setHistory(undo); }, []);
  const doRedo = useCallback(() => { lastNoteEdit.current = null; setHistory(redo); }, []);

  // ------------------------------------------------------------------- saving

  // The last state handed to the disk. Opening a piece is not an edit, so
  // nothing is written until the piece differs from this.
  //
  // It tracks what was *requested*, not what has finished: if she undoes back
  // to the stored state while a newer save is still writing, that newer save
  // will land, so the undone state must be written again after it.
  const requested = useRef({ piece: loaded.piece, name: loaded.name });
  // Writes run one at a time, in order, so an older save can never finish
  // after a newer one and leave stale work on disk.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const lastFailed = useRef(false);

  const saveNow = useCallback((snapshot: Piece, snapshotName: string) => {
    if (!hasOpfs()) return;
    const previous = requested.current;
    requested.current = { piece: snapshot, name: snapshotName };
    pending.current += 1;
    setSaveState('saving');
    chain.current = chain.current.then(async () => {
      try {
        await savePiece(loaded.id, snapshotName, snapshot);
        lastFailed.current = false;
        setSaveError(null);
      } catch (err) {
        lastFailed.current = true;
        // Let the next change (or tab hide) try this state again.
        if (requested.current.piece === snapshot) requested.current = previous;
        setSaveError(err instanceof Error ? err.message : String(err));
      } finally {
        pending.current -= 1;
        // Only the last write in the queue decides what the indicator says,
        // and an edit made while it was writing keeps it at "unsaved".
        if (pending.current === 0) {
          setSaveState((st) => (st === 'unsaved' || lastFailed.current ? 'unsaved' : 'saved'));
        }
      }
    });
  }, [loaded.id]);

  useEffect(() => {
    if (!hasOpfs()) return;
    if (piece === requested.current.piece && name === requested.current.name) return;
    // Unsaved the moment anything changes: an indicator that says "saved"
    // while a write is pending tells her the work is safe before it is.
    setSaveState('unsaved');
    const timer = window.setTimeout(() => saveNow(piece, name), 800);
    return () => window.clearTimeout(timer);
  }, [piece, name, saveNow]);

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState !== 'hidden') return;
      if (piece !== requested.current.piece || name !== requested.current.name) saveNow(piece, name);
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [piece, name, saveNow]);

  // Leaving the editor must not drop an edit the autosave delay is still
  // holding: a note typed just before pressing "Pieces" would otherwise vanish.
  const latest = useRef({ piece, name });
  latest.current = { piece, name };
  const flushPending = useCallback(() => {
    const l = latest.current;
    if (l.piece !== requested.current.piece || l.name !== requested.current.name) saveNow(l.piece, l.name);
    return chain.current;
  }, [saveNow]);
  useEffect(() => () => { void flushPending(); }, [flushPending]);

  const close = useCallback(async () => {
    player.stop();
    // Wait for the write, so the piece list shows what she just did.
    await flushPending();
    onClose();
  }, [flushPending, onClose, player]);

  // ----------------------------------------------------------------- playback

  useEffect(() => {
    player.setBuffer(loaded.buffer);
    player.onEnded = () => { setPlaying(false); setTime(0); };
    return () => player.dispose();
  }, [player, loaded.buffer]);

  useEffect(() => { player.grid = grid; }, [player, grid]);
  useEffect(() => { player.setClick(clickOn); }, [player, clickOn]);

  const loopRange = useMemo(() => {
    if (!loopOn) return null;
    const start = ecRange(grid, selLo).start;
    const end = ecRange(grid, selHi).end;
    return { start: Math.max(0, start), end: Math.min(duration, end) };
  }, [loopOn, grid, selLo, selHi, duration]);

  useEffect(() => { player.setLoop(loopRange); }, [player, loopRange]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => { setTime(player.currentTime); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, player]);

  const togglePlay = useCallback(() => {
    if (player.playing) {
      player.pause();
      setPlaying(false);
      setTime(player.currentTime);
    } else {
      player.play(time);
      setPlaying(true);
      setFollow(true);
    }
  }, [player, time]);

  const seek = useCallback((t: number) => {
    player.seek(t);
    setTime(player.currentTime);
  }, [player]);

  const selectEc = useCallback((ec: number, extend: boolean, jump: boolean) => {
    setSelection((s) => (extend ? { anchor: s.anchor, head: ec } : { anchor: ec, head: ec }));
    if (jump) seek(Math.max(0, ecRange(grid, extend ? Math.min(selection.anchor, ec) : ec).start));
  }, [grid, seek, selection.anchor]);

  const stepEc = useCallback((delta: number) => {
    const target = Math.min(span.last, Math.max(span.first, pos.ec + delta));
    // Stepping back from mid-phrase returns to its start first, like a CD player.
    const startOfCurrent = ecRange(grid, pos.ec).start;
    const ec = delta < 0 && time - startOfCurrent > 0.6 ? pos.ec : target;
    setSelection({ anchor: ec, head: ec });
    seek(Math.max(0, ecRange(grid, ec).start));
  }, [grid, pos.ec, seek, span, time]);

  // ----------------------------------------------------------------- keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.closest('input, textarea, select, [contenteditable]');
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        if (typing) return; // let the text box undo its own typing
        e.preventDefault();
        if (e.shiftKey) doRedo(); else doUndo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); doRedo(); return; }
      if (typing) {
        if (e.key === 'Escape') (target as HTMLElement).blur();
        return;
      }
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepEc(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepEc(1); }
      else if (e.key === 'l' || e.key === 'L') setLoopOn((v) => !v);
      else if (e.key === 'k' || e.key === 'K') setClickOn((v) => !v);
      else if (e.key === '1') editGrid((g) => setCountOne(g, player.currentTime));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, stepEc, doUndo, doRedo, editGrid, player]);

  // ------------------------------------------------------------------ render

  const segIndex = pos.segment;
  const segment = grid[segIndex];
  const ecCount = span.last - Math.max(0, span.first) + 1;

  return (
    <div className="editor">
      <header className="editor-header">
        <button className="back" onClick={() => void close()} aria-label="Back to all pieces">‹ Pieces</button>
        <div className="title-block">
          <input className="piece-title" value={name} aria-label="Piece name"
            onChange={(e) => setName(e.target.value)} spellCheck={false} />
          <div className="song-meta">
            {piece.song.fileName} · {formatTime(duration)} · {formatBpm(grid[0].bpm)} BPM
            {grid.length > 1 ? ` (+${grid.length - 1} tempo change${grid.length > 2 ? 's' : ''})` : ''} · {ecCount} eight-counts
          </div>
        </div>
        <div className="header-right">
          <button onClick={doUndo} disabled={!canUndo(history)} title="Undo (Ctrl+Z)">Undo</button>
          <button onClick={doRedo} disabled={!canRedo(history)} title="Redo (Ctrl+Shift+Z)">Redo</button>
          <span className={`save-state ${saveState}`} title={saveError ?? undefined} data-state={saveState}>
            {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…'
              : saveState === 'unavailable' ? 'Not saving — insecure address' : 'Unsaved changes'}
          </span>
        </div>
      </header>

      {saveError && <div className="error-bar" role="alert">Couldn’t save: {saveError}</div>}

      {!piece.gridConfirmed && (
        <div className="check-banner" role="status">
          <p>
            {loaded.detected && loaded.detected.confidence < 0.4
              ? <>The beat in this song is hard to pin down, so <b>{formatBpm(grid[0].bpm)} BPM</b> is a guess. </>
              : <>Found <b>{formatBpm(grid[0].bpm)} BPM</b>. </>}
            Play it with the click on and check the counts land on the beat.
            If the click is twice as fast or slow as you count, use ×2 or ÷2. If count 1 is in the wrong place,
            press <b>Count 1 here</b> (or the <kbd>1</kbd> key) right on a count 1.
          </p>
          <button className="primary" onClick={() => edit((p) => ({ ...p, gridConfirmed: true }))}>Counts look right</button>
        </div>
      )}

      <div className="transport">
        <button className="play" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (Space)">
          {playing ? '❚❚' : '▶'}
        </button>
        <button onClick={() => stepEc(-1)} title="Previous 8-count (←)" aria-label="Previous 8-count">⏮</button>
        <button onClick={() => stepEc(1)} title="Next 8-count (→)" aria-label="Next 8-count">⏭</button>
        <span className="clock">{formatTime(time)} / {formatTime(duration)}</span>
        <button className={`toggle ${loopOn ? 'on' : ''}`} aria-pressed={loopOn} onClick={() => setLoopOn((v) => !v)}
          title="Loop the selected 8-counts (L)">⟲ Loop selection</button>
        <button className={`toggle ${clickOn ? 'on' : ''}`} aria-pressed={clickOn} onClick={() => setClickOn((v) => !v)}
          title="Click on every count (K)">♩ Click</button>
        <div className="spacer" />
        <GridTools
          segment={segment}
          segIndex={segIndex}
          segCount={grid.length}
          onCountOne={() => editGrid((g) => setCountOne(g, player.currentTime))}
          onStartHere={() => editGrid((g) => startNumberingAt(g, player.currentTime))}
          canStartHere={segIndex === 0}
          onSplit={() => editGrid((g) => splitAt(g, player.currentTime))}
          onRemoveSegment={() => editGrid((g) => removeSegment(g, segIndex))}
          onNudge={(s) => editGrid((g) => nudge(g, segIndex, s))}
          onBpm={(b) => editGrid((g) => setBpm(g, segIndex, b))}
        />
      </div>

      <div className="upper">
        <CountDisplay
          piece={piece}
          pos={pos}
          beforeStart={time < 0 || pos.ec < 0}
        />
        <BlockPanel
          piece={piece}
          lo={selLo}
          hi={selHi}
          currentEc={pos.ec}
          loopOn={loopOn}
          onLoop={() => setLoopOn((v) => !v)}
          onNote={editNote}
          onAddSection={(n) => edit((p) => addSection(p, selLo, selHi, n))}
          onUpdateSection={(id, patch) => edit((p) => updateSection(p, id, patch))}
          onRemoveSection={(id) => edit((p) => removeSection(p, id))}
        />
      </div>

      <Timeline
        piece={piece}
        peaks={loaded.peaks}
        duration={duration}
        span={span}
        colW={colW}
        time={time}
        playing={playing}
        follow={follow}
        onStopFollowing={() => setFollow(false)}
        selLo={selLo}
        selHi={selHi}
        currentEc={pos.ec}
        onSelect={selectEc}
        onSeek={seek}
        onNote={editNote}
      />

      <footer className="statusbar">
        <span>{sectionAt(piece, pos.ec)?.name ?? ''}</span>
        <span className="keys">
          Space play · ← → 8-counts · L loop · K click · 1 count 1 here
        </span>
        <label className="zoom">
          Zoom
          <input type="range" min={64} max={260} value={colW} onChange={(e) => setColW(Number(e.target.value))}
            aria-label="Timeline zoom" />
        </label>
      </footer>
      <DevSeam piece={piece} name={name} saveState={saveState} time={time} player={player} seek={seek} selection={{ lo: selLo, hi: selHi }} />
    </div>
  );
}

/** Exposes editor state to the browser tests. Stripped from production builds. */
function DevSeam(props: Record<string, unknown>) {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__choreo = props;
  });
  return null;
}
