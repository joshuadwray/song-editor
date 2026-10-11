/**
 * The piece model.
 *
 * Same principle as Alainacity's project: the song's encoded file is stored
 * once and never touched, and everything she does is a small JSON graph laid
 * over it. That graph is the save format, so everything here must stay
 * JSON-serializable.
 *
 * Two clocks, deliberately:
 *  - notes and sections are keyed by 8-count NUMBER, so when she nudges the
 *    grid, her notes move with the counts — which is what she means.
 *  - video (phase 2) is keyed by SECONDS, so nudging the grid can never knock
 *    a rehearsal clip out of sync with the music.
 */

import { GridSegment } from './grid';

export interface SongInfo {
  /** Key of the encoded file in this piece's storage directory. */
  fileId: string;
  fileName: string;
  duration: number;
  sampleRate: number;
}

export interface Section {
  id: string;
  name: string;
  /** Index into SECTION_COLORS, so a retheme recolours every saved piece. */
  color: number;
  /** Inclusive range of 8-count indices. */
  startEc: number;
  endEc: number;
}

export interface Piece {
  song: SongInfo;
  grid: GridSegment[];
  /** True once she has touched the grid; detection never overwrites her choices. */
  gridConfirmed: boolean;
  sections: Section[];
  /** Note text keyed by 8-count index (as a string, for JSON). */
  notes: Record<string, string>;
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function newPiece(song: SongInfo, grid: GridSegment[]): Piece {
  return { song, grid, gridConfirmed: false, sections: [], notes: {} };
}

// --------------------------------------------------------------------- notes

export function noteAt(piece: Piece, ec: number): string {
  return piece.notes[String(ec)] ?? '';
}

export function setNote(piece: Piece, ec: number, text: string): Piece {
  const key = String(ec);
  if ((piece.notes[key] ?? '') === text) return piece;
  const notes = { ...piece.notes };
  // Empty notes are removed rather than stored, so the file holds only her words.
  if (text === '') delete notes[key];
  else notes[key] = text;
  return { ...piece, notes };
}

// ------------------------------------------------------------------ sections

export function sectionAt(piece: Piece, ec: number): Section | undefined {
  return piece.sections.find((s) => ec >= s.startEc && ec <= s.endEc);
}

/**
 * Name a range of 8-counts. Sections never overlap: whatever the new range
 * covers is trimmed out of existing sections, which may split one in two.
 */
export function addSection(piece: Piece, startEc: number, endEc: number, name: string): Piece {
  const lo = Math.min(startEc, endEc);
  const hi = Math.max(startEc, endEc);
  const kept: Section[] = [];
  for (const s of piece.sections) {
    if (s.endEc < lo || s.startEc > hi) {
      kept.push(s);
      continue;
    }
    if (s.startEc < lo) kept.push({ ...s, endEc: lo - 1 });
    if (s.endEc > hi) kept.push({ ...s, id: newId('sec'), startEc: hi + 1 });
  }
  const used = new Set(kept.map((s) => s.color));
  let color = 0;
  while (used.has(color) && color < SECTION_COLOR_COUNT - 1) color += 1;
  kept.push({ id: newId('sec'), name, color, startEc: lo, endEc: hi });
  kept.sort((a, b) => a.startEc - b.startEc);
  return { ...piece, sections: kept };
}

export function updateSection(
  piece: Piece,
  id: string,
  patch: Partial<Pick<Section, 'name' | 'color'>>,
): Piece {
  return {
    ...piece,
    sections: piece.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  };
}

export function removeSection(piece: Piece, id: string): Piece {
  return { ...piece, sections: piece.sections.filter((s) => s.id !== id) };
}

export const SECTION_COLOR_COUNT = 6;
