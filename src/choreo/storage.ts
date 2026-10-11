/**
 * Piece persistence.
 *
 * Same shape as Alainacity's projects (src/storage/projects.ts): a small JSON
 * document plus the encoded files it references, all under one directory per
 * piece, so deleting a piece removes everything it owns.
 *
 * In phase 2 the same directory holds the rehearsal videos, which is why
 * files are stored by our own id rather than by the name she imported them as.
 */

import { APP_NAME } from '../../choreo/app.config';
import { hasOpfs, listDir, readFile, removeEntry, writeFile } from '../storage/opfs';
import type { Piece } from './model/piece';

/** Bumped only for changes the loader cannot read. */
export const FORMAT_VERSION = 1;

/**
 * NEVER CHANGE THIS STRING. It is the key to every saved piece.
 *
 * Browser storage belongs to the origin, which this app shares with Alainacity
 * (and every other app on the site), so everything lives under its own
 * directory. Deliberately unrelated to the app's display name and URL so that
 * renaming either cannot orphan her work.
 */
const APP_DIR = 'choreo';

const dirFor = (id: string) => `${APP_DIR}/pieces/${id}`;
const jsonPath = (id: string) => `${dirFor(id)}/piece.json`;
const filePath = (id: string, fileId: string) => `${dirFor(id)}/files/${fileId}`;

export interface PieceSummary {
  id: string;
  name: string;
  updatedAt: number;
  songName: string;
  duration: number;
  bpm: number;
  noteCount: number;
}

interface StoredPiece {
  version: number;
  id: string;
  name: string;
  updatedAt: number;
  piece: Piece;
}

export function newPieceId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function savePiece(id: string, name: string, piece: Piece): Promise<void> {
  if (!hasOpfs()) throw new Error('This browser cannot store pieces.');
  const stored: StoredPiece = { version: FORMAT_VERSION, id, name, updatedAt: Date.now(), piece };
  await writeFile(jsonPath(id), JSON.stringify(stored));
}

export async function loadPiece(id: string): Promise<{ name: string; piece: Piece } | null> {
  const file = await readFile(jsonPath(id));
  if (!file) return null;
  let stored: StoredPiece;
  try {
    stored = JSON.parse(await file.text()) as StoredPiece;
  } catch {
    throw new Error('This piece’s file is damaged.');
  }
  if (stored.version > FORMAT_VERSION) {
    throw new Error(`This piece was saved by a newer version of ${APP_NAME} and cannot be opened.`);
  }
  return { name: stored.name, piece: stored.piece };
}

/** Newest first. A piece whose file is unreadable is skipped, not fatal. */
export async function listPieces(): Promise<PieceSummary[]> {
  if (!hasOpfs()) return [];
  const out: PieceSummary[] = [];
  for (const id of await listDir(`${APP_DIR}/pieces`)) {
    const file = await readFile(jsonPath(id));
    if (!file) continue;
    try {
      const s = JSON.parse(await file.text()) as StoredPiece;
      out.push({
        id,
        name: s.name,
        updatedAt: s.updatedAt,
        songName: s.piece.song.fileName,
        duration: s.piece.song.duration,
        bpm: s.piece.grid[0]?.bpm ?? 0,
        noteCount: Object.keys(s.piece.notes).length,
      });
    } catch {
      // A damaged entry should not hide the pieces that are still fine.
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deletePiece(id: string): Promise<void> {
  await removeEntry(dirFor(id));
}

/** Keep the original encoded file, exactly as imported. */
export async function storeFile(pieceId: string, fileId: string, data: Blob): Promise<void> {
  await writeFile(filePath(pieceId, fileId), data);
}

export async function readStoredFile(pieceId: string, fileId: string): Promise<File | null> {
  return readFile(filePath(pieceId, fileId));
}
