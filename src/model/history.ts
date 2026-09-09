/**
 * Undo/redo.
 *
 * Because every edit returns a new Project that structurally shares the
 * untouched parts of the old one, a history entry costs only the objects the
 * edit actually replaced. A 200-step history is kilobytes — the audio is never
 * part of it. That is the whole reason the clip model exists.
 */

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

const LIMIT = 200;

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/** Record a new state as an undoable step. */
export function commit<T>(history: History<T>, next: T): History<T> {
  if (next === history.present) return history;
  const past = [...history.past, history.present];
  return {
    past: past.length > LIMIT ? past.slice(past.length - LIMIT) : past,
    present: next,
    future: [],
  };
}

/** Replace the current state without creating an undo step (e.g. live drag). */
export function amend<T>(history: History<T>, next: T): History<T> {
  return { ...history, present: next };
}

/**
 * Close a run of `amend` calls as a single undo step.
 *
 * A drag produces dozens of intermediate states; recording each one would make
 * Ctrl+Z rewind a gesture pixel by pixel. Instead the drag amends freely and
 * ends by pushing the state it started from.
 */
export function finishAmend<T>(history: History<T>, base: T): History<T> {
  if (base === history.present) return history;
  const past = [...history.past, base];
  return {
    past: past.length > LIMIT ? past.slice(past.length - LIMIT) : past,
    present: history.present,
    future: [],
  };
}

export function canUndo<T>(h: History<T>): boolean {
  return h.past.length > 0;
}

export function canRedo<T>(h: History<T>): boolean {
  return h.future.length > 0;
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  return {
    past: h.past.slice(0, -1),
    present: h.past[h.past.length - 1],
    future: [h.present, ...h.future],
  };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  return {
    past: [...h.past, h.present],
    present: h.future[0],
    future: h.future.slice(1),
  };
}
