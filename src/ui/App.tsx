import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Clip,
  Project,
  Track,
  emptyProject,
  projectDuration,
  trackFromSource,
} from '../model/project';
import {
  addTrack,
  applyEffectToRange,
  copyRange,
  deleteRange,
  fadeRange,
  insertClips,
  moveClip,
  moveTrackTo,
  removeTrack,
  splitAt,
  splitIntoNewTrack,
  trackExtent,
  trimToRange,
  updateTrack,
} from '../model/edits';
import {
  amend,
  canRedo,
  canUndo,
  commit,
  finishAmend,
  initHistory,
  redo,
  undo,
} from '../model/history';
import { SourceRegistry, decodeAudio, decodeFile } from '../audio/decode';
import { AudioEngine } from '../audio/engine';
import { renderProject } from '../audio/export/render';
import { encodeWav } from '../audio/export/wav';
import { MP3_BITRATE, encodeMp3 } from '../audio/export/mp3';
import { hasFileSystemAccess, openAudioFiles, saveBlob } from '../storage/filesystem';
import { hasOpfs, requestPersistence } from '../storage/opfs';
import {
  ProjectSummary,
  deleteProject,
  listProjects,
  loadProject,
  newProjectId,
  readSource,
  saveProject,
  storeSource,
} from '../storage/projects';
import { computePeaks, type Peaks } from '../waveform/peaks';
import { applyUpdate, registerServiceWorker } from '../pwa';
import { Selection, View, formatTime } from '../waveform/draw';
import { ContextMenu, MenuBar, type Menu, type MenuItem } from './MenuBar';
import { Toolbar } from './Toolbar';
import { Timeline, type Tool } from './Timeline';

/** Warn before a Chromebook with 4GB starts swapping. */
const MEMORY_WARN_BYTES = 600 * 1024 * 1024;

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform ?? '');
const MOD = IS_MAC ? '⌘' : 'Ctrl';

/**
 * Resident audio, for the memory readout.
 *
 * A decimal below 10 MB: rounding 0.3 MB to "0 MB" claims there is no audio
 * loaded when there is.
 */
function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${mb.toFixed(0)} MB`;
}

function hasRange(selection: Selection | null): selection is Selection {
  return selection !== null && selection.end - selection.start > 1e-6;
}

export function App() {
  const [history, setHistory] = useState(() => initHistory(emptyProject()));
  const project = history.present;

  const [selection, setSelection] = useState<Selection | null>(null);
  const [view, setView] = useState<View>({ start: 0, pxPerSec: 60 });
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [peaks, setPeaks] = useState<Map<string, Peaks>>(() => new Map());
  const [focusedTrackId, setFocusedTrackId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; trackId: string } | null>(
    null,
  );
  const [projectId, setProjectId] = useState(() => newProjectId());
  const [projectName, setProjectName] = useState('Untitled project');
  const [recents, setRecents] = useState<ProjectSummary[]>([]);
  const [updateReady, setUpdateReady] = useState(false);
  const [saveState, setSaveState] = useState<'unsaved' | 'saving' | 'saved' | 'unavailable'>(
    hasOpfs() ? 'unsaved' : 'unavailable',
  );
  // Sync-lock keeps a multi-track project aligned: a ripple cut on one track
  // would otherwise slide it out of step with the others, silently.
  const [syncLock, setSyncLock] = useState(true);
  const [status, setStatus] = useState('Ready.');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const engineRef = useRef<AudioEngine | null>(null);
  if (engineRef.current === null) engineRef.current = new AudioEngine();
  const engine = engineRef.current;

  const registryRef = useRef<SourceRegistry | null>(null);
  if (registryRef.current === null) registryRef.current = new SourceRegistry();
  const registry = registryRef.current;

  const clipboardRef = useRef<Clip[] | null>(null);

  const duration = projectDuration(project);
  // Recomputed each render; it walks a handful of buffers, not their samples.
  const audioBytes = registry.byteSize();
  const directFiles = hasFileSystemAccess();

  // Edits that should be undoable go through here; everything the user can
  // reverse with Ctrl+Z is a single call to this.
  const commitProject = useCallback((next: Project) => {
    setHistory((h) => commit(h, next));
  }, []);

  /**
   * Continuous interactions — dragging a clip, sliding a volume fader — amend
   * the current state instead of committing, then close as a single undo step.
   * Otherwise one gesture would leave dozens of entries in the history.
   */
  const amendBase = useRef<Project | null>(null);

  const amendProject = useCallback((next: Project) => {
    setHistory((h) => {
      if (amendBase.current === null) amendBase.current = h.present;
      return amend(h, next);
    });
  }, []);

  const endAmend = useCallback(() => {
    const base = amendBase.current;
    amendBase.current = null;
    if (base) setHistory((h) => finishAmend(h, base));
  }, []);

  /** Tracks the selection covers. Effects apply here and nowhere else. */
  const selectedTracks = useCallback((): string[] | null => {
    if (selection?.trackIds && selection.trackIds.length > 0) return selection.trackIds;
    if (focusedTrackId) return [focusedTrackId];
    return null;
  }, [selection, focusedTrackId]);

  /**
   * Tracks a *time-changing* edit applies to.
   *
   * With sync-lock on, cuts and pastes hit every track so a multi-track project
   * cannot drift out of alignment. Effects deliberately do not use this — you
   * never want vocal reduction applied to every track at once.
   */
  const timeEditTracks = useCallback((): string[] | null => {
    if (syncLock && project.tracks.length > 1) return null;
    return selectedTracks();
  }, [syncLock, project.tracks.length, selectedTracks]);

  const refreshRecents = useCallback(() => {
    void listProjects().then(setRecents);
  }, []);

  // Ask for persistent storage on first run. Without it Chrome may evict the
  // project store under disk pressure, silently — the worst failure this app
  // could have, so it is requested before anything is ever written.
  useEffect(() => {
    if (!hasOpfs()) return;
    void requestPersistence();
    refreshRecents();
  }, [refreshRecents]);

  // Offline support. An update is announced, never applied mid-session — a
  // reload that discards what she is doing is worse than running yesterday's
  // build for another few minutes.
  useEffect(() => {
    registerServiceWorker(() => setUpdateReady(true));
  }, []);

  useEffect(() => {
    engine.onStateChange = (state) => setIsPlaying(state === 'playing');
    return () => {
      engine.onStateChange = null;
    };
  }, [engine]);

  useEffect(() => () => engine.dispose(), [engine]);

  // Drive the playhead from the audio clock while playing.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = () => {
      setPlayhead(engine.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, engine]);

  // ------------------------------------------------------------------ saving

  const saveNow = useCallback(
    async (id: string, name: string, snapshot: Project) => {
      if (!hasOpfs() || snapshot.tracks.length === 0) return;
      setSaveState('saving');
      try {
        await saveProject(id, name, snapshot);
        setSaveState('saved');
        refreshRecents();
      } catch (err) {
        setSaveState('unsaved');
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshRecents],
  );

  // Autosave on a debounce. Edits arrive in bursts while dragging, and writing
  // on every one of them would hammer the disk for no benefit.
  useEffect(() => {
    if (!hasOpfs() || project.tracks.length === 0) return;
    // Mark unsaved the moment anything changes. An indicator that stays on
    // "saved" while there are pending edits is worse than none at all — it
    // tells her the work is safe when it is not yet written.
    setSaveState('unsaved');
    const timer = window.setTimeout(() => void saveNow(projectId, projectName, project), 800);
    return () => window.clearTimeout(timer);
  }, [project, projectId, projectName, saveNow]);

  // Closing the tab or switching away must not lose the last few seconds of
  // work that the debounce is still holding.
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') void saveNow(projectId, projectName, project);
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [project, projectId, projectName, saveNow]);

  // ----------------------------------------------------------- opening projects

  const fitView = useCallback((total: number) => {
    if (total <= 0) return;
    const el = document.querySelector('.lanes-wrap');
    const width = el ? el.clientWidth : 800;
    setView({ start: 0, pxPerSec: Math.max(0.5, (width - 20) / total) });
  }, []);


  const resetSession = useCallback(() => {
    engine.stop();
    registry.clear();
    setPeaks(new Map());
    setSelection(null);
    setPlayhead(0);
    setFocusedTrackId(null);
  }, [engine, registry]);

  const newProject = useCallback(() => {
    resetSession();
    setHistory(initHistory(emptyProject()));
    setProjectId(newProjectId());
    setProjectName('Untitled project');
    setSaveState(hasOpfs() ? 'unsaved' : 'unavailable');
    setStatus('Started a new project.');
  }, [resetSession]);

  const openProject = useCallback(
    async (id: string) => {
      setBusy('Opening project…');
      setError(null);
      try {
        const loaded = await loadProject(id);
        if (!loaded) {
          setError('That project could not be found.');
          return;
        }
        const ctx = engine.context();
        resetSession();

        // Decode each stored source back into memory. A source that has gone
        // missing is reported rather than silently producing a mute track.
        const missing: string[] = [];
        for (const source of Object.values(loaded.project.sources)) {
          const file = await readSource(id, source.id);
          if (!file) {
            missing.push(source.name);
            continue;
          }
          const buffer = await decodeAudio(file, source.name, ctx);
          registry.set(source.id, buffer);
          void computePeaks(buffer).then((p) => {
            setPeaks((prev) => new Map(prev).set(source.id, p));
          });
        }

        setHistory(initHistory(loaded.project));
        setProjectId(id);
        setProjectName(loaded.name);
        setSaveState('saved');
        requestAnimationFrame(() => fitView(projectDuration(loaded.project)));
        setStatus(`Opened "${loaded.name}".`);
        if (missing.length > 0) {
          setError(
            `Some audio could not be found in storage (${missing.join(', ')}). Those tracks will be silent.`,
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [engine, registry, resetSession, fitView],
  );

  const removeProject = useCallback(
    async (id: string) => {
      await deleteProject(id);
      refreshRecents();
      if (id === projectId) newProject();
      setStatus('Project deleted.');
    },
    [projectId, newProject, refreshRecents],
  );

  // ---------------------------------------------------------------- importing

  const importFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setError(null);
      setBusy(files.length === 1 ? 'Reading audio…' : `Reading ${files.length} files…`);
      const wasEmpty = project.tracks.length === 0;
      try {
        const ctx = engine.context();
        let next = project;
        const newPeaks = new Map(peaks);
        let firstTrackId: string | null = null;

        for (const file of files) {
          const { source, buffer } = await decodeFile(file, ctx);
          registry.set(source.id, buffer);
          // Keep the original encoded file so the project can be reopened even
          // if she later moves or deletes what she imported.
          if (hasOpfs()) await storeSource(projectId, source.id, file);
          const track = trackFromSource(source);
          firstTrackId ??= track.id;
          next = addTrack({ ...next, sources: { ...next.sources, [source.id]: source } }, track);
          // Peaks are computed off-thread; the track appears immediately and
          // fills in a moment later.
          void computePeaks(buffer).then((p) => {
            setPeaks((prev) => new Map(prev).set(source.id, p));
          });
          newPeaks.delete(source.id);
        }

        commitProject(next);
        setPeaks(newPeaks);
        if (firstTrackId) setFocusedTrackId(firstTrackId);

        // Show the whole file on open. Landing on a fragment of a waveform at
        // some arbitrary zoom is disorienting if you did not choose the zoom.
        if (wasEmpty) {
          requestAnimationFrame(() => {
            const lane = document.querySelector('.lanes-wrap');
            const laneWidth = lane ? lane.clientWidth : 800;
            const total = projectDuration(next);
            if (total > 0) {
              setView({ start: 0, pxPerSec: Math.max(0.5, (laneWidth - 20) / total) });
            }
          });
        }
        setStatus(`Opened ${files.map((f) => f.name).join(', ')}`);

        if (registry.byteSize() > MEMORY_WARN_BYTES) {
          setError(
            'A lot of audio is open at once. On a low-memory machine, closing tracks you are finished with will keep things responsive.',
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [project, peaks, registry, engine, commitProject, projectId],
  );

  const handleOpen = useCallback(async () => {
    try {
      const files = await openAudioFiles();
      await importFiles(files);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [importFiles]);

  useEffect(() => {
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []).filter(
        (f) => f.type.startsWith('audio/') || /\.(mp3|wav|flac|ogg|oga|m4a|aac|opus)$/i.test(f.name),
      );
      if (files.length > 0) void importFiles(files);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [importFiles]);

  // ---------------------------------------------------------------- transport

  const stop = useCallback(() => {
    engine.stop();
    const at = engine.currentTime;
    setPlayhead(at);
    // Leave the editing cursor where the audio stopped. Without this, pausing
    // at the point you want to split and then splitting would cut at wherever
    // you last clicked instead — which is the whole workflow, silently wrong.
    // A range selection is preserved, since stopping should not discard it.
    setSelection((current) =>
      current && current.end - current.start > 1e-6
        ? current
        : { start: at, end: at, trackIds: current?.trackIds ?? null },
    );
  }, [engine]);

  const play = useCallback(() => {
    if (duration <= 0) return;
    // A range selection plays just that range, the way Audacity does.
    const from = hasRange(selection) ? selection.start : playhead;
    const to = hasRange(selection) ? selection.end : undefined;
    engine.play(project, registry, Math.min(from, duration), to);
  }, [engine, project, registry, selection, playhead, duration]);

  const togglePlay = useCallback(() => {
    if (isPlaying) stop();
    else play();
  }, [isPlaying, play, stop]);

  const seek = useCallback(
    (time: number) => {
      const t = Math.max(0, Math.min(time, duration));
      engine.seek(t);
      setPlayhead(t);
    },
    [engine, duration],
  );

  // -------------------------------------------------------------------- edits

  const doDelete = useCallback(
    (ripple: boolean) => {
      if (!hasRange(selection)) return;
      commitProject(
        deleteRange(project, timeEditTracks(), selection.start, selection.end, ripple),
      );
      setSelection({ start: selection.start, end: selection.start, trackIds: selection.trackIds });
      setStatus(ripple ? 'Cut section removed.' : 'Section silenced.');
    },
    [project, selection, timeEditTracks, commitProject],
  );

  const doCopy = useCallback(() => {
    if (!hasRange(selection)) return;
    clipboardRef.current = copyRange(project, selectedTracks(), selection.start, selection.end);
    setStatus('Copied.');
  }, [project, selection, selectedTracks]);

  const doCut = useCallback(() => {
    if (!hasRange(selection)) return;
    doCopy();
    doDelete(true);
  }, [selection, doCopy, doDelete]);

  const doPaste = useCallback(() => {
    const clips = clipboardRef.current;
    const trackId = focusedTrackId ?? project.tracks[0]?.id;
    if (!clips || clips.length === 0 || !trackId) return;
    const at = selection ? selection.start : playhead;
    commitProject(insertClips(project, trackId, at, clips));
    setStatus('Pasted.');
  }, [project, selection, playhead, focusedTrackId, commitProject]);

  const doTrim = useCallback(() => {
    if (!hasRange(selection)) return;
    commitProject(trimToRange(project, timeEditTracks(), selection.start, selection.end));
    setStatus('Trimmed to selection.');
  }, [project, selection, timeEditTracks, commitProject]);

  /** Where a split will land: the cursor, which stopping playback moves. */
  const splitPoint = selection ? selection.start : playhead;

  const doSplit = useCallback(() => {
    commitProject(splitAt(project, selectedTracks(), splitPoint));
    setStatus(`Split at ${formatTime(splitPoint, true)}.`);
  }, [project, splitPoint, selectedTracks, commitProject]);

  /** Audacity's "Split New": everything after the cursor becomes its own track. */
  const doSplitIntoNewTrack = useCallback(
    (trackId?: string) => {
      const target = trackId ?? focusedTrackId ?? project.tracks[0]?.id;
      if (!target) return;
      const next = splitIntoNewTrack(project, target, splitPoint);
      if (next === project) {
        setError('There is nothing to split at the cursor — it is at the edge of the audio.');
        return;
      }
      commitProject(next);
      setStatus(`Split into a new track at ${formatTime(splitPoint, true)}.`);
    },
    [project, splitPoint, focusedTrackId, commitProject],
  );

  const doFade = useCallback(
    (direction: 'in' | 'out') => {
      if (!hasRange(selection)) return;
      commitProject(fadeRange(project, selectedTracks(), selection.start, selection.end, direction));
      setStatus(`Applied fade ${direction}.`);
    },
    [project, selection, selectedTracks, commitProject],
  );

  /** Selection-scoped effects — the shape the censoring workflow needs. */
  const doEffect = useCallback(
    (kind: 'vocalReduce' | 'silence' | 'duck' | 'muffle') => {
      if (!hasRange(selection)) return;
      const tracks = selectedTracks();

      if (kind === 'vocalReduce') {
        // Centre cancellation has nothing to cancel against in a mono source.
        const ids = new Set(
          project.tracks
            .filter((t) => tracks === null || tracks.includes(t.id))
            .flatMap((t) => t.clips.map((c) => c.sourceId)),
        );
        const allMono = [...ids].every((id) => (project.sources[id]?.channels ?? 2) < 2);
        if (ids.size > 0 && allMono) {
          setError(
            'Vocal reduction needs a stereo track. It works by cancelling what is common to the left and right channels, and a mono track has nothing to compare.',
          );
          return;
        }
      }

      const effect =
        kind === 'vocalReduce'
          ? ({ type: 'vocalReduce', amount: 1, lowHz: 100, highHz: 8000 } as const)
          : kind === 'duck'
            ? ({ type: 'duck', amount: 0.75 } as const)
            : kind === 'muffle'
              ? ({ type: 'muffle', cutoffHz: 700 } as const)
              : ({ type: 'silence' } as const);

      commitProject(applyEffectToRange(project, tracks, selection.start, selection.end, effect));
      setStatus(`Applied ${kind === 'vocalReduce' ? 'vocal reduction' : kind} to selection.`);
    },
    [project, selection, timeEditTracks, commitProject],
  );

  const handleTrackChange = useCallback(
    (trackId: string, patch: Partial<Track>) => {
      const next = updateTrack(project, trackId, patch);
      amendProject(next);
      // Solo is a global decision, so the engine reconsiders every track.
      engine.applyTrackParams(next);
    },
    [project, amendProject, engine],
  );

  const handleClipDragMove = useCallback(
    (trackId: string, clipId: string, newStart: number) => {
      amendProject(moveClip(project, trackId, clipId, newStart));
    },
    [project, amendProject],
  );

  const handleRemoveTrack = useCallback(
    (trackId: string) => {
      const next = removeTrack(project, trackId);
      // Free the decoded audio for sources nothing references any more.
      for (const id of Object.keys(project.sources)) {
        if (!next.sources[id]) registry.delete(id);
      }
      commitProject(next);
      if (focusedTrackId === trackId) setFocusedTrackId(null);
      setStatus('Track closed.');
    },
    [project, registry, focusedTrackId, commitProject],
  );

  // Test seam, development builds only — never present in a production bundle.
  // Lets the browser suite assert on real editor state instead of scraping the
  // DOM for it.
  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__songEditor = {
        project, selection, view, tool, syncLock, playhead,
        projectId, projectName, saveState, recents,
      };
    }
  }, [project, selection, view, tool, syncLock, playhead, projectId, projectName, saveState, recents]);

  // ------------------------------------------------------------------ zooming

  const zoomBy = useCallback((factor: number) => {
    setView((v) => {
      const centre = v.start; // keep the left edge stable; simple and predictable
      return { pxPerSec: Math.min(20000, Math.max(0.5, v.pxPerSec * factor)), start: centre };
    });
  }, []);

  const zoomFit = useCallback(() => fitView(duration), [fitView, duration]);

  // ------------------------------------------------------------------ exports

  type ExportFormat = 'mp3' | 'wav';

  /**
   * Render and save.
   *
   * One path for both formats and for whole-project, selection and single-track
   * exports, so what gets written can never diverge between them.
   */
  const exportAudio = useCallback(
    async (format: ExportFormat, trackId?: string) => {
      const track = trackId ? project.tracks.find((t) => t.id === trackId) : undefined;
      if (trackId && !track) return;

      // A track split off partway through starts partway along the timeline;
      // exporting it from zero would prepend minutes of silence.
      const extent = track ? trackExtent(track) : null;
      if (track && !extent) return;
      const range = track
        ? extent!
        : hasRange(selection)
          ? { start: selection.start, end: selection.end }
          : undefined;
      const scope: Project = track
        ? { sources: project.sources, tracks: [{ ...track, muted: false, soloed: false }] }
        : project;
      if (projectDuration(scope) <= 0) return;

      setBusy('Rendering…');
      setError(null);
      try {
        const buffer = await renderProject(scope, registry, { range });
        const blob =
          format === 'mp3'
            ? await encodeMp3(buffer, MP3_BITRATE, (fraction) =>
                setBusy(`Encoding MP3… ${Math.round(fraction * 100)}%`),
              )
            : encodeWav(buffer);

        const stem = track ? track.name : hasRange(selection) ? `${projectName} (selection)` : projectName;
        const name = `${stem}.${format}`;
        const accept: Record<string, string[]> =
          format === 'mp3' ? { 'audio/mpeg': ['.mp3'] } : { 'audio/wav': ['.wav'] };
        const saved = await saveBlob(blob, name, accept);
        setStatus(
          saved
            ? `Exported ${name} (${(blob.size / 1024 / 1024).toFixed(1)} MB)`
            : 'Export cancelled.',
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [project, projectName, registry, selection],
  );

  // -------------------------------------------------------------- keyboard

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal keys from a text field (track name editing).
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      const mod = IS_MAC ? event.metaKey : event.ctrlKey;

      if (event.key === ' ') {
        event.preventDefault();
        togglePlay();
        return;
      }
      if (event.key === 'F1') {
        event.preventDefault();
        setTool('select');
        return;
      }
      if (event.key === 'F5') {
        event.preventDefault();
        setTool('shift');
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        seek(0);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        seek(duration);
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !mod) {
        event.preventDefault();
        doDelete(true);
        return;
      }
      if (!mod) return;

      switch (event.key.toLowerCase()) {
        case 'z':
          event.preventDefault();
          setHistory((h) => (event.shiftKey ? redo(h) : undo(h)));
          break;
        case 'y':
          event.preventDefault();
          setHistory((h) => redo(h));
          break;
        case 'x':
          event.preventDefault();
          doCut();
          break;
        case 'c':
          event.preventDefault();
          doCopy();
          break;
        case 'v':
          event.preventDefault();
          doPaste();
          break;
        case 'a':
          event.preventDefault();
          setSelection({ start: 0, end: duration, trackIds: null });
          break;
        case 't':
          event.preventDefault();
          doTrim();
          break;
        case 'i':
          event.preventDefault();
          if (event.altKey) doSplitIntoNewTrack();
          else doSplit();
          break;
        case 'o':
          event.preventDefault();
          void handleOpen();
          break;
        case 's':
          event.preventDefault();
          void saveNow(projectId, projectName, project);
          break;
        case '1':
          event.preventDefault();
          zoomBy(2);
          break;
        case '2':
          event.preventDefault();
          zoomFit();
          break;
        case '3':
          event.preventDefault();
          zoomBy(0.5);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    togglePlay,
    seek,
    duration,
    doDelete,
    doCut,
    doCopy,
    doPaste,
    doTrim,
    doSplit,
    doSplitIntoNewTrack,
    handleOpen,
    saveNow,
    projectId,
    projectName,
    project,
    zoomBy,
    zoomFit,
  ]);

  // --------------------------------------------------------------- menu model

  const rangeSelected = hasRange(selection);
  const empty = project.tracks.length === 0;
  const splitLabel = formatTime(splitPoint, true);

  /**
   * Split entries, shared by the Edit menu and the right-click menu.
   *
   * They name the exact time they will act on. A right-click menu that splits
   * somewhere other than where you clicked is confusing unless it says so, and
   * the cursor is drawn at that same point.
   */
  const splitItems = (trackId?: string): MenuItem[] => [
    {
      label: `Split at ${splitLabel}`,
      shortcut: `${MOD}+I`,
      disabled: empty,
      action: doSplit,
    },
    {
      label: `Split into a new track at ${splitLabel}`,
      shortcut: `${MOD}+Alt+I`,
      disabled: empty,
      action: () => doSplitIntoNewTrack(trackId),
    },
  ];

  const menus: Menu[] = [
    {
      label: 'File',
      items: [
        { label: 'New project', action: newProject },
        { label: 'Open audio…', shortcut: `${MOD}+O`, action: () => void handleOpen() },
        {
          label: 'Save project now',
          shortcut: `${MOD}+S`,
          disabled: !hasOpfs() || empty,
          action: () => void saveNow(projectId, projectName, project),
        },
        ...(recents.length > 0
          ? ([{ separator: true, label: 'sep-recents' }] as MenuItem[]).concat(
              recents.slice(0, 6).map((r) => ({
                label: `${r.id === projectId ? '✓ ' : ''}${r.name}`,
                shortcut: new Date(r.updatedAt).toLocaleDateString(),
                action: () => void openProject(r.id),
              })),
            )
          : []),
        { separator: true, label: 'sep1' },
        {
          label: rangeSelected ? 'Export selection as MP3…' : 'Export as MP3…',
          disabled: empty,
          action: () => void exportAudio('mp3'),
        },
        {
          label: rangeSelected ? 'Export selection as WAV…' : 'Export as WAV…',
          disabled: empty,
          action: () => void exportAudio('wav'),
        },
        { separator: true, label: 'sep2' },
        {
          label: 'Export this track as MP3…',
          disabled: !focusedTrackId,
          action: () => focusedTrackId && void exportAudio('mp3', focusedTrackId),
        },
        {
          label: 'Export this track as WAV…',
          disabled: !focusedTrackId,
          action: () => focusedTrackId && void exportAudio('wav', focusedTrackId),
        },
      ],
    },
    {
      label: 'Edit',
      items: [
        {
          label: 'Undo',
          shortcut: `${MOD}+Z`,
          disabled: !canUndo(history),
          action: () => setHistory((h) => undo(h)),
        },
        {
          label: 'Redo',
          shortcut: `${MOD}+Shift+Z`,
          disabled: !canRedo(history),
          action: () => setHistory((h) => redo(h)),
        },
        { separator: true, label: 'sep1' },
        { label: 'Cut', shortcut: `${MOD}+X`, disabled: !rangeSelected, action: doCut },
        { label: 'Copy', shortcut: `${MOD}+C`, disabled: !rangeSelected, action: doCopy },
        {
          label: 'Paste',
          shortcut: `${MOD}+V`,
          disabled: !clipboardRef.current || empty,
          action: doPaste,
        },
        {
          label: 'Delete',
          shortcut: 'Del',
          disabled: !rangeSelected,
          action: () => doDelete(true),
        },
        {
          label: 'Silence (leave gap)',
          disabled: !rangeSelected,
          action: () => doDelete(false),
        },
        { separator: true, label: 'sep2' },
        {
          label: 'Trim to selection',
          shortcut: `${MOD}+T`,
          disabled: !rangeSelected,
          action: doTrim,
        },
        ...splitItems(),
      ],
    },
    {
      label: 'Select',
      items: [
        {
          label: 'All',
          shortcut: `${MOD}+A`,
          disabled: empty,
          action: () => setSelection({ start: 0, end: duration, trackIds: null }),
        },
        { label: 'None', disabled: !selection, action: () => setSelection(null) },
      ],
    },
    {
      label: 'Effect',
      items: [
        { label: 'Fade In', disabled: !rangeSelected, action: () => doFade('in') },
        { label: 'Fade Out', disabled: !rangeSelected, action: () => doFade('out') },
        { separator: true, label: 'sep1' },
        {
          label: 'Reduce vocals',
          disabled: !rangeSelected,
          action: () => doEffect('vocalReduce'),
        },
        { label: 'Muffle', disabled: !rangeSelected, action: () => doEffect('muffle') },
        { label: 'Lower volume', disabled: !rangeSelected, action: () => doEffect('duck') },
        { label: 'Silence', disabled: !rangeSelected, action: () => doEffect('silence') },
      ],
    },
    {
      label: 'Tracks',
      items: [
        {
          label: 'Move track up',
          disabled: !focusedTrackId || project.tracks[0]?.id === focusedTrackId,
          action: () => focusedTrackId && commitProject(moveTrackTo(project, focusedTrackId, -1)),
        },
        {
          label: 'Move track down',
          disabled:
            !focusedTrackId || project.tracks[project.tracks.length - 1]?.id === focusedTrackId,
          action: () => focusedTrackId && commitProject(moveTrackTo(project, focusedTrackId, 1)),
        },
        { separator: true, label: 'sep1' },
        {
          label: `${syncLock ? '✓ ' : ''}Sync-lock tracks`,
          action: () => setSyncLock((on) => !on),
        },
        { separator: true, label: 'sep2' },
        {
          label: 'Close focused track',
          disabled: !focusedTrackId,
          action: () => focusedTrackId && handleRemoveTrack(focusedTrackId),
        },
      ],
    },
  ];

  return (
    <div className="app">
      <MenuBar
        menus={menus}
        right={
          <input
            className="project-name"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            aria-label="Project name"
            title="Project name"
          />
        }
      />
      <Toolbar
        tool={tool}
        onToolChange={setTool}
        isPlaying={isPlaying}
        canPlay={duration > 0}
        playhead={playhead}
        selectionStart={selection?.start ?? null}
        selectionEnd={selection?.end ?? null}
        onPlay={play}
        onStop={stop}
        onSkipStart={() => seek(0)}
        onSkipEnd={() => seek(duration)}
        onZoomIn={() => zoomBy(2)}
        onZoomOut={() => zoomBy(0.5)}
        onZoomFit={zoomFit}
      />

      <Timeline
        project={project}
        peaks={peaks}
        registry={registry}
        tool={tool}
        view={view}
        onViewChange={setView}
        selection={selection}
        onSelectionChange={setSelection}
        playhead={playhead}
        isPlaying={isPlaying}
        onSeek={seek}
        focusedTrackId={focusedTrackId}
        onFocusTrack={setFocusedTrackId}
        onTrackChange={handleTrackChange}
        onTrackCommit={endAmend}
        onRemoveTrack={handleRemoveTrack}
        onImportClick={() => void handleOpen()}
        recents={recents}
        onOpenProject={(id) => void openProject(id)}
        onDeleteProject={(id) => void removeProject(id)}
        onClipDragStart={() => setStatus('Dragging audio…')}
        onClipDragMove={handleClipDragMove}
        onClipDragEnd={() => {
          endAmend();
          setStatus('Moved audio along the timeline.');
        }}
        onContextMenu={(event, trackId) => {
          setFocusedTrackId(trackId);
          setContextMenu({ x: event.clientX, y: event.clientY, trackId });
        }}
      />

      <div className="statusbar">
        <span>{busy ?? status}</span>
        <span className="spacer" />
        <span className="dim">
          {project.tracks.length} track{project.tracks.length === 1 ? '' : 's'} ·{' '}
          {duration.toFixed(2)}s
        </span>
        {/* An empty project has nothing to save; claiming otherwise is noise. */}
        <span
          hidden={empty && saveState !== 'unavailable'}
          className={saveState === 'unavailable' ? 'mem warn' : 'mem'}
          title={
            saveState === 'unavailable'
              ? 'Projects can only be saved over HTTPS or on localhost. Work in this session will be lost when the tab closes.'
              : 'Projects save automatically.'
          }
        >
          {saveState === 'unavailable'
            ? 'not saving'
            : saveState === 'saving'
              ? 'saving…'
              : saveState === 'saved'
                ? 'saved'
                : 'unsaved changes'}
        </span>
        {project.tracks.length > 1 && (
          <span className="mem" title="Cuts and pastes apply to every track, keeping them aligned.">
            {syncLock ? 'sync-locked' : 'tracks independent'}
          </span>
        )}
        {/* Resident audio, shown so memory headroom on a low-RAM machine can be
            checked at a glance instead of through DevTools. */}
        <span className={audioBytes > MEMORY_WARN_BYTES ? 'mem warn' : 'mem'}>
          {formatMegabytes(audioBytes)} audio
        </span>
        {/* Direct file access needs a secure context. Saying so here explains
            why Export lands in Downloads, without needing DevTools to find out. */}
        <span className="mem" title={
          directFiles
            ? 'Export opens a save dialog and can write back to Drive.'
            : 'This page is not in a secure context, so exports download to the Downloads folder instead of opening a save dialog.'
        }>
          {directFiles ? 'direct file access' : 'saves to Downloads'}
        </span>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            ...splitItems(contextMenu.trackId),
            { separator: true, label: 'sep1' },
            { label: 'Cut', shortcut: `${MOD}+X`, disabled: !rangeSelected, action: doCut },
            { label: 'Copy', shortcut: `${MOD}+C`, disabled: !rangeSelected, action: doCopy },
            {
              label: 'Paste',
              shortcut: `${MOD}+V`,
              disabled: !clipboardRef.current,
              action: doPaste,
            },
            { label: 'Delete', disabled: !rangeSelected, action: () => doDelete(true) },
            { separator: true, label: 'sep2' },
            {
              label: 'Reduce vocals',
              disabled: !rangeSelected,
              action: () => doEffect('vocalReduce'),
            },
            { label: 'Silence', disabled: !rangeSelected, action: () => doEffect('silence') },
            { separator: true, label: 'sep3' },
            {
              label: 'Export this track as MP3…',
              action: () => void exportAudio('mp3', contextMenu.trackId),
            },
          ]}
        />
      )}

      {updateReady && (
        <div className="update-banner">
          <span>A new version of Song Editor is ready.</span>
          <button type="button" onClick={applyUpdate}>
            Reload to update
          </button>
          <button type="button" className="ghost" onClick={() => setUpdateReady(false)}>
            Later
          </button>
        </div>
      )}

      {busy && <div className="busy-overlay">{busy}</div>}
    </div>
  );
}
