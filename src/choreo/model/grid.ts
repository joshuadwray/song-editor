/**
 * The 8-count grid.
 *
 * A grid is a list of segments rather than one BPM, because a song cut in
 * Alainacity can change tempo — or just drop half a beat — at a splice. Each
 * segment says "count 1 of 8-count N falls at this time, at this tempo", and
 * holds until the next segment begins. Most songs have exactly one.
 *
 * Indexing: 8-count 0 is the one that begins at the first segment's count 1,
 * and is shown to her as "1". Music before that (an intro she is not counting)
 * gets negative indices and is drawn as pre-roll.
 *
 * Only `start` and `bpm` are stored. The 8-count numbering of later segments is
 * derived, so the grid can never hold two contradicting numberings.
 */

export interface GridSegment {
  /** Song time of count 1 for this segment's first 8-count. */
  start: number;
  bpm: number;
}

export interface Position {
  ec: number;
  /** 1..8 */
  count: number;
  /** 0..1 progress through the current count. */
  frac: number;
  segment: number;
}

export const MIN_BPM = 40;
export const MAX_BPM = 240;

export const beatLength = (bpm: number) => 60 / bpm;
export const ecLength = (bpm: number) => 480 / bpm;

/** Floating-point slack when a time sits exactly on a boundary. */
const EPS = 1e-6;

function sorted(grid: GridSegment[]): GridSegment[] {
  return [...grid].sort((a, b) => a.start - b.start);
}

/**
 * Index of the first 8-count of every segment.
 *
 * A later segment starts a fresh 8-count: if the splice lands mid-phrase, the
 * phrase before it is simply cut short.
 */
export function firstEcs(grid: GridSegment[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < grid.length; i += 1) {
    if (i === 0) {
      out.push(0);
      continue;
    }
    const prev = grid[i - 1];
    const beats = (grid[i].start - prev.start) / beatLength(prev.bpm);
    // Strictly inside the previous segment's last (possibly partial) 8-count.
    out.push(out[i - 1] + Math.ceil(beats / 8 - EPS));
  }
  return out;
}

function segmentIndexAt(grid: GridSegment[], time: number): number {
  let idx = 0;
  for (let i = 1; i < grid.length; i += 1) if (grid[i].start <= time + EPS) idx = i;
  return idx;
}

export function positionAt(grid: GridSegment[], time: number): Position {
  const segment = segmentIndexAt(grid, time);
  const seg = grid[segment];
  const beats = (time - seg.start) / beatLength(seg.bpm) + EPS;
  const whole = Math.floor(beats);
  const ecOffset = Math.floor(whole / 8);
  const count = whole - ecOffset * 8 + 1;
  return {
    ec: firstEcs(grid)[segment] + ecOffset,
    count,
    frac: Math.min(1, Math.max(0, beats - whole - EPS)),
    segment,
  };
}

/** Time range of an 8-count. The last 8-count of a segment may be cut short. */
export function ecRange(grid: GridSegment[], ec: number): { start: number; end: number } {
  const firsts = firstEcs(grid);
  let i = 0;
  for (let k = 1; k < grid.length; k += 1) if (firsts[k] <= ec) i = k;
  const seg = grid[i];
  const start = seg.start + (ec - firsts[i]) * ecLength(seg.bpm);
  let end = start + ecLength(seg.bpm);
  if (i + 1 < grid.length) end = Math.min(end, grid[i + 1].start);
  return { start, end };
}

/** Time of a given count within an 8-count (count is 1..8; fractional allowed). */
export function countTime(grid: GridSegment[], ec: number, count: number): number {
  const { start } = ecRange(grid, ec);
  const seg = grid[segmentIndexAt(grid, start)];
  return start + (count - 1) * beatLength(seg.bpm);
}

/** Every 8-count that overlaps [0, duration), first to last. */
export function ecSpan(grid: GridSegment[], duration: number): { first: number; last: number } {
  const first = positionAt(grid, 0).ec;
  const last = positionAt(grid, Math.max(0, duration - 0.001)).ec;
  return { first, last };
}

/** Every beat in [from, to), with its count — for the click track and tick marks. */
export function beatsBetween(
  grid: GridSegment[],
  from: number,
  to: number,
): { time: number; count: number; ec: number }[] {
  const out: { time: number; count: number; ec: number }[] = [];
  const firsts = firstEcs(grid);
  for (let i = 0; i < grid.length; i += 1) {
    const seg = grid[i];
    const segEnd = i + 1 < grid.length ? grid[i + 1].start : Infinity;
    // Segment 0 extends backwards to cover any pre-roll.
    const segStart = i === 0 ? -Infinity : seg.start;
    const lo = Math.max(from, segStart);
    const hi = Math.min(to, segEnd);
    if (lo >= hi) continue;
    const bl = beatLength(seg.bpm);
    let k = Math.ceil((lo - seg.start) / bl - EPS);
    for (;;) {
      const t = seg.start + k * bl;
      if (t >= hi - EPS) break;
      const ecOffset = Math.floor(k / 8);
      out.push({ time: t, count: k - ecOffset * 8 + 1, ec: firsts[i] + ecOffset });
      k += 1;
    }
  }
  return out;
}

// ------------------------------------------------------------------ editing

const clampBpm = (bpm: number) => Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));

/**
 * "Count 1 is here": re-phase the grid so a count 1 lands on this time, while
 * keeping the 8-count numbers as they were. She presses this while hearing
 * 8-count 12 to fix the timing — it must still be 8-count 12 afterwards, or
 * every note from there on would jump to a different phrase.
 *
 * So the segment's start moves by less than half an 8-count either way.
 */
export function setCountOne(grid: GridSegment[], time: number): GridSegment[] {
  const g = sorted(grid);
  const i = segmentIndexAt(g, time);
  const len = ecLength(g[i].bpm);
  const k = Math.round((time - g[i].start) / len);
  let start = time - k * len;
  // A later segment cannot move back past the one before it.
  if (i > 0) {
    const floor = g[i - 1].start + beatLength(g[i - 1].bpm);
    while (start < floor) start += len;
  }
  const next = [...g];
  next[i] = { ...g[i], start };
  return normalize(next);
}

/**
 * "Start counting here": this becomes 8-count 1, and anything before it is
 * pre-roll. For skipping an intro she does not dance to. Only meaningful in
 * the first segment — later segments continue the numbering.
 */
export function startNumberingAt(grid: GridSegment[], time: number): GridSegment[] {
  const g = sorted(grid);
  if (segmentIndexAt(g, time) !== 0) return g;
  return normalize([{ ...g[0], start: time }, ...g.slice(1)]);
}

/** Start a new tempo/phase section here: count 1 of a fresh 8-count. */
export function splitAt(grid: GridSegment[], time: number): GridSegment[] {
  const g = sorted(grid);
  const i = segmentIndexAt(g, time);
  if (i === 0 && time < g[0].start) return g;
  if (Math.abs(g[i].start - time) < 0.05) return g;
  return normalize([...g, { start: time, bpm: g[i].bpm }]);
}

export function removeSegment(grid: GridSegment[], index: number): GridSegment[] {
  if (index <= 0 || index >= grid.length) return grid;
  return grid.filter((_, i) => i !== index);
}

/** Slide one segment's count 1 earlier or later. */
export function nudge(grid: GridSegment[], segment: number, seconds: number): GridSegment[] {
  const g = sorted(grid);
  const next = [...g];
  next[segment] = { ...g[segment], start: g[segment].start + seconds };
  return normalize(next);
}

export function setBpm(grid: GridSegment[], segment: number, bpm: number): GridSegment[] {
  const next = [...grid];
  next[segment] = { ...grid[segment], bpm: clampBpm(bpm) };
  return next;
}

/** Keep segments ordered and at least one beat apart; a collision merges them. */
function normalize(grid: GridSegment[]): GridSegment[] {
  const g = sorted(grid);
  const out: GridSegment[] = [g[0]];
  for (let i = 1; i < g.length; i += 1) {
    const prev = out[out.length - 1];
    if (g[i].start - prev.start < beatLength(prev.bpm) * 0.5) continue;
    out.push(g[i]);
  }
  return out;
}

/**
 * Tap tempo: BPM from a series of tap times, or null until there are enough.
 * Uses a least-squares line through the taps rather than averaging intervals,
 * so one early or late tap shifts the answer far less.
 */
export function tapTempo(taps: number[]): number | null {
  if (taps.length < 4) return null;
  const n = taps.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += i; sy += taps[i]; sxx += i * i; sxy += i * taps[i];
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  if (!(slope > 0)) return null;
  return clampBpm(60 / slope);
}
