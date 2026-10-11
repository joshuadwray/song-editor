/**
 * The start screen, and opening or creating a piece.
 *
 * Everything slow — decoding, tempo detection, peaks — happens here, before the
 * editor mounts, so the editor can assume a fully loaded piece and never has
 * to render a half-ready state.
 */

import { useCallback, useEffect, useState } from 'react';
import { APP_NAME } from '../../../choreo/app.config';
import { decodeAudio } from '../../audio/decode';
import { applyUpdate, registerServiceWorker } from '../../pwa';
import { hasOpfs, requestPersistence } from '../../storage/opfs';
import { openAudioFiles } from '../../storage/filesystem';
import { computePeaks, type Peaks } from '../../waveform/peaks';
import { analyseTempo } from '../audio/tempo';
import { newId, newPiece, type Piece } from '../model/piece';
import {
  deletePiece, listPieces, loadPiece, newPieceId, readStoredFile, savePiece, storeFile,
  type PieceSummary,
} from '../storage';
import { formatBpm, formatTime } from './format';
import { PieceEditor } from './PieceEditor';

export interface LoadedPiece {
  id: string;
  name: string;
  piece: Piece;
  buffer: AudioBuffer;
  peaks: Peaks;
  /** Set only for a piece created this session, to show what detection found. */
  detected?: { bpm: number; confidence: number };
}

/** Decoding at a fixed rate keeps sample positions stable between sessions. */
const decodeContext = () => new OfflineAudioContext(2, 1, 44100);

async function createPiece(file: File): Promise<LoadedPiece> {
  const buffer = await decodeAudio(file, file.name, decodeContext());
  const [tempo, peaks] = await Promise.all([analyseTempo(buffer), computePeaks(buffer)]);
  const id = newPieceId();
  const fileId = newId('song');
  if (hasOpfs()) await storeFile(id, fileId, file);
  const piece = newPiece(
    { fileId, fileName: file.name, duration: buffer.duration, sampleRate: buffer.sampleRate },
    [{ start: tempo.beatOne, bpm: tempo.bpm }],
  );
  const name = file.name.replace(/\.[^.]+$/, '');
  if (hasOpfs()) await savePiece(id, name, piece);
  return { id, name, piece, buffer, peaks, detected: { bpm: tempo.bpm, confidence: tempo.confidence } };
}

async function openPiece(id: string): Promise<LoadedPiece> {
  const loaded = await loadPiece(id);
  if (!loaded) throw new Error('That piece could not be found.');
  const file = await readStoredFile(id, loaded.piece.song.fileId);
  if (!file) throw new Error('The song for this piece is missing from storage.');
  const buffer = await decodeAudio(file, loaded.piece.song.fileName, decodeContext());
  const peaks = await computePeaks(buffer);
  return { id, name: loaded.name, piece: loaded.piece, buffer, peaks };
}

export function App() {
  const [current, setCurrent] = useState<LoadedPiece | null>(null);
  const [pieces, setPieces] = useState<PieceSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [dragging, setDragging] = useState(false);

  const refresh = useCallback(() => {
    void listPieces().then(setPieces).catch(() => setPieces([]));
  }, []);

  useEffect(() => {
    refresh();
    registerServiceWorker(() => setUpdateReady(true));
  }, [refresh]);

  const run = useCallback(async (label: string, work: () => Promise<LoadedPiece>) => {
    setError(null);
    setBusy(label);
    try {
      const loaded = await work();
      void requestPersistence();
      setCurrent(loaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const startNew = useCallback(async (file?: File) => {
    const chosen = file ?? (await openAudioFiles())[0];
    if (!chosen) return;
    void run(`Reading “${chosen.name}” and finding the beat…`, () => createPiece(chosen));
  }, [run]);

  const close = useCallback(() => {
    setCurrent(null);
    refresh();
  }, [refresh]);

  if (current) {
    return (
      <>
        {updateReady && <UpdateBanner />}
        <PieceEditor key={current.id} loaded={current} onClose={close} />
      </>
    );
  }

  return (
    <div
      className={`start ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|flac|ogg|aac)$/i.test(f.name));
        if (file) void startNew(file);
      }}
    >
      {updateReady && <UpdateBanner />}
      <div className="start-inner">
        <h1>{APP_NAME}</h1>
        <p className="start-lede">Load a song, and it’s counted out in 8-counts for you to build the dance on.</p>

        <button className="primary big" disabled={!!busy} onClick={() => void startNew()}>
          + New piece from a song…
        </button>
        <p className="hint">Or drop an audio file here. A finished mix from Alainacity works best.</p>

        {busy && <p className="busy" role="status">{busy}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {!hasOpfs() && (
          <p className="error">This page isn’t running from a secure address, so pieces can’t be saved.</p>
        )}

        {pieces.length > 0 && (
          <>
            <h2>Your pieces</h2>
            <ul className="pieces">
              {pieces.map((p) => (
                <li key={p.id} className="piece-row">
                  <button className="piece-open" disabled={!!busy}
                    onClick={() => void run(`Opening “${p.name}”…`, () => openPiece(p.id))}>
                    <span className="piece-name">{p.name}</span>
                    <span className="piece-meta">
                      {p.songName} · {formatTime(p.duration)} · {formatBpm(p.bpm)} BPM · {p.noteCount} {p.noteCount === 1 ? 'note' : 'notes'}
                      {' · '}edited {new Date(p.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                  </button>
                  {confirmDelete === p.id ? (
                    <span className="confirm">
                      Delete for good?
                      <button className="danger" onClick={async () => {
                        await deletePiece(p.id);
                        setConfirmDelete(null);
                        refresh();
                      }}>Delete</button>
                      <button onClick={() => setConfirmDelete(null)}>Keep</button>
                    </span>
                  ) : (
                    <button className="piece-delete" aria-label={`Delete ${p.name}`} onClick={() => setConfirmDelete(p.id)}>Delete</button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function UpdateBanner() {
  return (
    <div className="update-banner" role="status">
      A new version of {APP_NAME} is ready.
      <button onClick={applyUpdate}>Restart to update</button>
    </div>
  );
}
