import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Project, Track, clipEnd, projectDuration } from '../model/project';
import type { ProjectSummary } from '../storage/projects';
import { snapCandidates } from '../model/edits';
import { SourceRegistry } from '../audio/decode';
import type { Peaks } from '../waveform/peaks';
import { COLORS, Selection, View, drawRuler, drawTrack, timeToX, xToTime } from '../waveform/draw';
import { TrackPanel } from './TrackPanel';

export const PANEL_WIDTH = 150;
const RULER_HEIGHT = 26;
const TRACK_HEIGHT = 118;
/** How close, in pixels, a dragged edge must come before it snaps. */
const SNAP_PX = 8;

export type Tool = 'select' | 'shift';

/** Size a canvas for the device pixel ratio and return a scaled 2D context. */
function prepareCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(width * dpr));
  const h = Math.max(1, Math.floor(height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

/**
 * Nudge a dragged clip onto a nearby landmark.
 *
 * Both edges are candidates, so a clip can be butted up against its neighbour
 * from either side. Without this, aligning two tracks by eye leaves offsets
 * that are too small to see and large enough to hear.
 */
function applySnap(
  start: number,
  duration: number,
  candidates: number[],
  pxPerSec: number,
): { time: number; guide: number | null } {
  const threshold = SNAP_PX / pxPerSec;
  let bestDistance = threshold;
  let time = start;
  let guide: number | null = null;

  for (const candidate of candidates) {
    for (const offset of [0, duration]) {
      const distance = Math.abs(start + offset - candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        time = candidate - offset;
        guide = candidate;
      }
    }
  }
  return { time, guide };
}

interface TrackLaneProps {
  track: Track;
  peaks: Map<string, Peaks>;
  registry: SourceRegistry;
  view: View;
  width: number;
  selection: Selection | null;
}

function TrackLane({ track, peaks, registry, view, width, selection }: TrackLaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = prepareCanvas(canvas, width, TRACK_HEIGHT);
    if (!g) return;
    drawTrack(g, { track, peaks, registry, view, width, height: TRACK_HEIGHT, selection });
  }, [track, peaks, registry, view, width, selection]);

  return <canvas ref={canvasRef} className="lane-canvas" data-track-id={track.id} />;
}

export interface TimelineProps {
  project: Project;
  peaks: Map<string, Peaks>;
  registry: SourceRegistry;
  tool: Tool;
  view: View;
  onViewChange: (view: View) => void;
  selection: Selection | null;
  onSelectionChange: (selection: Selection | null) => void;
  playhead: number;
  isPlaying: boolean;
  onSeek: (time: number) => void;
  focusedTrackId: string | null;
  onFocusTrack: (trackId: string) => void;
  onTrackChange: (trackId: string, patch: Partial<Track>) => void;
  onTrackCommit: () => void;
  onRemoveTrack: (trackId: string) => void;
  onImportClick: () => void;
  onClipDragStart: () => void;
  onClipDragMove: (trackId: string, clipId: string, newStart: number) => void;
  onClipDragEnd: () => void;
  onContextMenu: (event: React.MouseEvent, trackId: string) => void;
  recents: ProjectSummary[];
  onOpenProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
}

export function Timeline(props: TimelineProps) {
  const {
    project, peaks, registry, tool, view, onViewChange, selection, onSelectionChange,
    playhead, isPlaying, onSeek, focusedTrackId, onFocusTrack, onTrackChange, onTrackCommit,
    onRemoveTrack, onImportClick, onClipDragStart, onClipDragMove, onClipDragEnd, onContextMenu,
    recents, onOpenProject, onDeleteProject,
  } = props;

  const lanesRef = useRef<HTMLDivElement>(null);
  const rulerWrapRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const hscrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [snapGuide, setSnapGuide] = useState<number | null>(null);

  const duration = projectDuration(project);
  const lanesHeight = Math.max(TRACK_HEIGHT, project.tracks.length * TRACK_HEIGHT);

  useEffect(() => {
    const el = lanesRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(1, Math.floor(entry.contentRect.width)));
    });
    observer.observe(el);
    setWidth(Math.max(1, Math.floor(el.clientWidth)));
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const canvas = rulerRef.current;
    if (!canvas) return;
    const g = prepareCanvas(canvas, width, RULER_HEIGHT);
    if (g) drawRuler(g, view, width, RULER_HEIGHT);
  }, [view, width]);

  // Playhead, cursor and snap guide live on their own canvas so following the
  // playhead during playback does not force a waveform redraw every frame.
  useLayoutEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const g = prepareCanvas(canvas, width, lanesHeight);
    if (!g) return;
    g.clearRect(0, 0, width, lanesHeight);

    if (selection && selection.end - selection.start < 1e-6) {
      const x = Math.round(timeToX(selection.start, view));
      if (x >= 0 && x <= width) {
        g.fillStyle = COLORS.cursor;
        g.fillRect(x, 0, 1, lanesHeight);
      }
    }

    if (snapGuide !== null) {
      const x = Math.round(timeToX(snapGuide, view));
      if (x >= 0 && x <= width) {
        g.fillStyle = COLORS.snapGuide;
        g.fillRect(x, 0, 1, lanesHeight);
      }
    }

    const px = Math.round(timeToX(playhead, view));
    if (px >= 0 && px <= width) {
      g.fillStyle = COLORS.playhead;
      g.fillRect(px, 0, 2, lanesHeight);
    }
  }, [playhead, selection, view, width, lanesHeight, snapGuide]);

  // Keep the native scrollbar in sync when the view moves programmatically.
  useEffect(() => {
    const el = hscrollRef.current;
    if (!el) return;
    const target = view.start * view.pxPerSec;
    if (Math.abs(el.scrollLeft - target) > 1) el.scrollLeft = target;
  }, [view]);

  // Follow the playhead, scrolling a screen at a time rather than continuously.
  useEffect(() => {
    if (!isPlaying) return;
    const x = timeToX(playhead, view);
    if (x > width - 40 || x < 0) {
      onViewChange({ ...view, start: Math.max(0, playhead - 40 / view.pxPerSec) });
    }
  }, [playhead, isPlaying, view, width, onViewChange]);

  const timeAtEvent = useCallback(
    (event: { clientX: number }): number => {
      const el = lanesRef.current;
      if (!el) return 0;
      return Math.max(0, xToTime(event.clientX - el.getBoundingClientRect().left, view));
    },
    [view],
  );

  /** Which track lane a pointer is over. Drives selections that span tracks. */
  const trackIndexAt = useCallback(
    (clientY: number): number => {
      const el = lanesRef.current;
      if (!el || project.tracks.length === 0) return 0;
      const y = clientY - el.getBoundingClientRect().top;
      return Math.max(0, Math.min(project.tracks.length - 1, Math.floor(y / TRACK_HEIGHT)));
    },
    [project.tracks.length],
  );

  /**
   * Wheel and trackpad handling.
   *
   * This must be a native listener registered with `passive: false`. React
   * registers wheel handlers passively at the root, so preventDefault() from an
   * onWheel prop is silently ignored — and a trackpad pinch (which arrives as
   * ctrl+wheel) then zooms the whole browser window on top of the waveform.
   */
  useEffect(() => {
    const handler = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const el = lanesRef.current;
        if (!el) return;
        const x = event.clientX - el.getBoundingClientRect().left;
        const anchorTime = xToTime(x, view);
        // Clamp before scaling: a fast pinch reports a huge delta, which would
        // otherwise jump several zoom levels in a single gesture.
        const step = Math.max(-50, Math.min(50, event.deltaY));
        const pxPerSec = Math.min(20000, Math.max(0.5, view.pxPerSec * Math.exp(-step * 0.006)));
        // Zoom about the pointer, so the audio under it stays put.
        onViewChange({ pxPerSec, start: Math.max(0, anchorTime - x / pxPerSec) });
        return;
      }

      // Leave a genuine vertical gesture alone when the track list can actually
      // scroll, so a project with many tracks stays navigable.
      const body = bodyRef.current;
      const vertical = Math.abs(event.deltaY) > Math.abs(event.deltaX);
      if (vertical && !event.shiftKey && body && body.scrollHeight > body.clientHeight + 1) return;

      event.preventDefault();
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      onViewChange({ ...view, start: Math.max(0, view.start + delta / view.pxPerSec) });
    };

    const targets = [lanesRef.current, rulerWrapRef.current].filter(Boolean) as HTMLElement[];
    for (const el of targets) el.addEventListener('wheel', handler, { passive: false });
    return () => {
      for (const el of targets) el.removeEventListener('wheel', handler);
    };
  }, [view, onViewChange]);

  /** Time Shift: slide the clip under the pointer along its track. */
  const beginClipDrag = (event: React.MouseEvent): void => {
    const track = project.tracks[trackIndexAt(event.clientY)];
    if (!track) return;
    const grabTime = timeAtEvent(event);
    const clip = track.clips.find((c) => grabTime >= c.timelineStart && grabTime < clipEnd(c));
    if (!clip) return;

    onFocusTrack(track.id);
    // Hold the clip where it was grabbed, rather than snapping it to the cursor.
    const grabOffset = grabTime - clip.timelineStart;
    const duration = clipEnd(clip) - clip.timelineStart;
    const candidates = snapCandidates(project, clip.id);
    onClipDragStart();

    const onMove = (e: MouseEvent) => {
      const wanted = Math.max(0, timeAtEvent(e) - grabOffset);
      const snapped = applySnap(wanted, duration, candidates, view.pxPerSec);
      setSnapGuide(snapped.guide);
      onClipDragMove(track.id, clip.id, Math.max(0, snapped.time));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setSnapGuide(null);
      onClipDragEnd();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const beginSelection = (event: React.MouseEvent): void => {
    const startIndex = trackIndexAt(event.clientY);
    const startTrack = project.tracks[startIndex];
    if (startTrack) onFocusTrack(startTrack.id);

    const anchor = timeAtEvent(event);
    let moved = false;

    // Dragging down across lanes widens the selection to those tracks, so an
    // edit can span a multi-track project the way Audacity's does.
    const tracksBetween = (index: number): string[] => {
      const lo = Math.min(startIndex, index);
      const hi = Math.max(startIndex, index);
      return project.tracks.slice(lo, hi + 1).map((t) => t.id);
    };

    onSelectionChange({ start: anchor, end: anchor, trackIds: tracksBetween(startIndex) });

    const onMove = (e: MouseEvent) => {
      const t = timeAtEvent(e);
      if (Math.abs(t - anchor) * view.pxPerSec > 2) moved = true;
      onSelectionChange({
        start: Math.min(anchor, t),
        end: Math.max(anchor, t),
        trackIds: tracksBetween(trackIndexAt(e.clientY)),
      });
    };
    const onUp = (e: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (!moved) {
        // A plain click places the cursor rather than making a zero-width
        // selection you cannot see.
        const t = timeAtEvent(e);
        onSelectionChange({ start: t, end: t, trackIds: tracksBetween(startIndex) });
        onSeek(t);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onLaneMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    if (tool === 'shift') beginClipDrag(event);
    else beginSelection(event);
  };

  const scrollWidth = Math.max(duration, 1) * view.pxPerSec + width;

  return (
    <div className="timeline">
      <div className="timeline-header">
        <div className="panel-spacer" style={{ width: PANEL_WIDTH }} />
        <div className="ruler-wrap" ref={rulerWrapRef} onMouseDown={(e) => onSeek(timeAtEvent(e))}>
          <canvas ref={rulerRef} />
        </div>
      </div>

      <div className="timeline-body" ref={bodyRef}>
        <div className="panel-column" style={{ width: PANEL_WIDTH }}>
          {project.tracks.map((track) => (
            <TrackPanel
              key={track.id}
              track={track}
              height={TRACK_HEIGHT}
              focused={track.id === focusedTrackId}
              onFocus={() => onFocusTrack(track.id)}
              onChange={(patch) => onTrackChange(track.id, patch)}
              onCommit={onTrackCommit}
              onRemove={() => onRemoveTrack(track.id)}
            />
          ))}
        </div>

        <div
          className={`lanes-wrap tool-${tool}`}
          ref={lanesRef}
          onMouseDown={onLaneMouseDown}
          onContextMenu={(e) => {
            e.preventDefault();
            const track = project.tracks[trackIndexAt(e.clientY)];
            if (track) onContextMenu(e, track.id);
          }}
        >
          {project.tracks.map((track) => (
            <TrackLane
              key={track.id}
              track={track}
              peaks={peaks}
              registry={registry}
              view={view}
              width={width}
              selection={selection}
            />
          ))}
          <canvas ref={overlayRef} className="overlay-canvas" />

          {project.tracks.length === 0 && (
            <div className="empty-state">
              <button type="button" className="primary" onClick={onImportClick}>
                Open an audio file
              </button>
              <p className="hint">or drag a file anywhere onto this window</p>

              {recents.length > 0 && (
                <div className="recents">
                  <h2>Recent projects</h2>
                  <ul>
                    {recents.slice(0, 8).map((r) => (
                      <li key={r.id}>
                        <button type="button" className="recent" onClick={() => onOpenProject(r.id)}>
                          <span className="recent-name">{r.name}</span>
                          <span className="recent-meta">
                            {r.trackCount} track{r.trackCount === 1 ? '' : 's'} ·{' '}
                            {Math.round(r.duration)}s · {new Date(r.updatedAt).toLocaleString()}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="recent-delete"
                          title={`Delete "${r.name}"`}
                          onClick={() => onDeleteProject(r.id)}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div
        className="hscroll"
        ref={hscrollRef}
        onScroll={(e) => {
          const start = e.currentTarget.scrollLeft / view.pxPerSec;
          if (Math.abs(start - view.start) > 1e-6) onViewChange({ ...view, start });
        }}
      >
        <div style={{ width: scrollWidth, height: 1 }} />
      </div>
    </div>
  );
}
