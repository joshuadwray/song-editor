import assert from 'node:assert/strict';
import {
  beatsBetween, countTime, ecRange, ecSpan, firstEcs, nudge, positionAt, removeSegment,
  setBpm, setCountOne, splitAt, startNumberingAt, tapTempo,
} from '../src/choreo/model/grid';
import type { GridSegment } from '../src/choreo/model/grid';
import { addSection, newPiece, noteAt, removeSection, sectionAt, setNote } from '../src/choreo/model/piece';
import { detectTempo } from '../src/choreo/model/tempo';

let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log('  ok', name); };
const near = (a: number, b: number, tol: number, what = '') =>
  assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (±${tol})`);

// ------------------------------------------------------------------- grid

console.log('grid: one steady segment');
{
  // 120 BPM: a beat is 0.5 s, an 8-count is 4 s. Count 1 of 8-count "1" at 2 s.
  const g: GridSegment[] = [{ start: 2, bpm: 120 }];
  check('count 1 sits at the anchor', () => {
    const p = positionAt(g, 2);
    assert.equal(p.ec, 0); assert.equal(p.count, 1);
  });
  check('counts advance every beat', () => {
    assert.equal(positionAt(g, 2.5).count, 2);
    assert.equal(positionAt(g, 5.99).count, 8);
    assert.deepEqual([positionAt(g, 6).ec, positionAt(g, 6).count], [1, 1]);
  });
  check('music before count 1 is pre-roll with negative 8-counts', () => {
    assert.equal(positionAt(g, 1).ec, -1);
    assert.equal(positionAt(g, 1).count, 7);
  });
  check('an 8-count spans exactly 4 s', () => assert.deepEqual(ecRange(g, 3), { start: 14, end: 18 }));
  check('count times land on beats', () => near(countTime(g, 3, 5), 16, 1e-9));
  check('the span covers the whole song', () => assert.deepEqual(ecSpan(g, 30), { first: -1, last: 6 }));
  check('a beat exactly on a boundary is not lost to rounding', () => {
    const g2: GridSegment[] = [{ start: 0.1, bpm: 123.4 }];
    const t = ecRange(g2, 17).start;
    assert.deepEqual([positionAt(g2, t).ec, positionAt(g2, t).count], [17, 1]);
  });
  check('beats between two times carry their counts', () => {
    const beats = beatsBetween(g, 2, 6);
    assert.equal(beats.length, 8);
    assert.deepEqual(beats.map((b) => b.count), [1, 2, 3, 4, 5, 6, 7, 8]);
  });
}

console.log('grid: a splice that changes tempo');
{
  // 8-counts 0..2 at 120 BPM from 0 s; at 10 s (mid 8-count 2) the edit jumps to 100 BPM.
  const g: GridSegment[] = [{ start: 0, bpm: 120 }, { start: 10, bpm: 100 }];
  check('the segment after a splice starts a fresh 8-count', () => assert.deepEqual(firstEcs(g), [0, 3]));
  check('the 8-count cut by the splice is shortened, not overlapped', () =>
    assert.deepEqual(ecRange(g, 2), { start: 8, end: 10 }));
  check('after the splice the new tempo applies', () => {
    const r = ecRange(g, 4);
    near(r.start, 10 + 4.8, 1e-9); near(r.end, 10 + 9.6, 1e-9);
  });
  check('positions after the splice use the new segment', () => {
    const p = positionAt(g, 10 + 0.6 * 3);
    assert.deepEqual([p.ec, p.count, p.segment], [3, 4, 1]);
  });
  check('beats switch tempo at the splice', () => {
    const beats = beatsBetween(g, 9, 11.3);
    assert.deepEqual(beats.map((b) => +b.time.toFixed(3)), [9, 9.5, 10, 10.6, 11.2]);
    assert.deepEqual(beats.map((b) => b.count), [3, 4, 1, 2, 3]);
  });
  check('splitting adds a segment with the same tempo', () => {
    const s = splitAt([{ start: 0, bpm: 120 }], 7.3);
    assert.deepEqual(s, [{ start: 0, bpm: 120 }, { start: 7.3, bpm: 120 }]);
  });
  check('splitting in the pre-roll does nothing', () =>
    assert.deepEqual(splitAt([{ start: 4, bpm: 120 }], 1), [{ start: 4, bpm: 120 }]));
  check('the first segment cannot be removed', () => assert.equal(removeSegment(g, 0), g));
  check('removing a splice rejoins the grid', () => assert.deepEqual(removeSegment(g, 1), [g[0]]));
  check('tempo is clamped to danceable values', () => assert.equal(setBpm(g, 0, 900)[0].bpm, 240));
}

console.log('grid: count 1 here keeps her numbering');
{
  const g: GridSegment[] = [{ start: 0.2, bpm: 120 }];
  // She hears that count 1 of 8-count 12 is really at 44.35 s, 0.15 s late.
  const ec11 = ecRange(g, 11).start; // 44.2
  check('re-phases the grid onto the new time', () => {
    const fixed = setCountOne(g, ec11 + 0.15);
    near(ecRange(fixed, 11).start, ec11 + 0.15, 1e-9);
  });
  check('the 8-count under the playhead keeps its number', () => {
    const fixed = setCountOne(g, ec11 + 0.15);
    assert.equal(positionAt(fixed, ec11 + 0.16).ec, 11);
  });
  check('a press late in the phrase still re-phases, not renumbers', () => {
    const fixed = setCountOne(g, ec11 - 0.3);
    assert.equal(positionAt(fixed, ec11 - 0.29).ec, 11);
    assert.equal(positionAt(fixed, ec11 - 0.29).count, 1);
  });
  check('start numbering here makes this 8-count 1', () => {
    const s = startNumberingAt(g, 31.7);
    assert.deepEqual([positionAt(s, 31.7).ec, positionAt(s, 31.7).count], [0, 1]);
  });
  check('a later segment cannot be re-phased behind its neighbour', () => {
    const two: GridSegment[] = [{ start: 0, bpm: 120 }, { start: 10, bpm: 120 }];
    const fixed = setCountOne(two, 10.1);
    assert.ok(fixed[1].start > fixed[0].start + 0.4);
    near(fixed[1].start, 10.1, 1e-9);
  });
  check('nudging moves count 1 by exactly the step', () =>
    near(nudge(g, 0, -0.01)[0].start, 0.19, 1e-12));
  check('nudging a splice into its neighbour merges them', () => {
    const two: GridSegment[] = [{ start: 0, bpm: 120 }, { start: 0.3, bpm: 120 }];
    assert.equal(nudge(two, 1, -0.2).length, 1);
  });
}

console.log('tap tempo');
{
  check('needs at least four taps', () => assert.equal(tapTempo([0, 0.5, 1]), null));
  check('steady taps give the exact tempo', () => near(tapTempo([0, 0.5, 1, 1.5, 2])!, 120, 1e-9));
  check('one sloppy tap barely moves the answer', () => {
    const taps = [0, 0.5, 1.06, 1.5, 2, 2.5, 3, 3.5];
    near(tapTempo(taps)!, 120, 1.5);
  });
}

// ------------------------------------------------------------------- piece

console.log('notes and sections');
{
  const p = newPiece({ fileId: 'f', fileName: 's.mp3', duration: 180, sampleRate: 44100 }, [{ start: 0, bpm: 120 }]);
  check('a note attaches to its 8-count', () => assert.equal(noteAt(setNote(p, 4, 'chaîné x2'), 4), 'chaîné x2'));
  check('clearing a note removes it from the file', () =>
    assert.deepEqual(setNote(setNote(p, 4, 'x'), 4, '').notes, {}));
  check('an unchanged note returns the same piece (no spurious save)', () => {
    const q = setNote(p, 4, 'x');
    assert.equal(setNote(q, 4, 'x'), q);
  });
  const a = addSection(p, 0, 3, 'Intro');
  const b = addSection(a, 4, 11, 'Verse 1');
  check('sections cover their 8-counts', () => {
    assert.equal(sectionAt(b, 2)?.name, 'Intro');
    assert.equal(sectionAt(b, 11)?.name, 'Verse 1');
    assert.equal(sectionAt(b, 12), undefined);
  });
  check('adjacent sections get different colours', () => assert.notEqual(b.sections[0].color, b.sections[1].color));
  check('a new section trims what it overlaps', () => {
    const c = addSection(b, 6, 7, 'Breakdown');
    assert.deepEqual(c.sections.map((s) => [s.name, s.startEc, s.endEc]), [
      ['Intro', 0, 3], ['Verse 1', 4, 5], ['Breakdown', 6, 7], ['Verse 1', 8, 11],
    ]);
  });
  check('a section can be removed', () => assert.equal(removeSection(b, b.sections[0].id).sections.length, 1));
}

// ------------------------------------------------------------------- tempo

/** Deterministic noise, so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

interface TrackSpec {
  bpm: number;
  seconds: number;
  sampleRate?: number;
  /** Silence before the first downbeat. */
  lead?: number;
  noise?: number;
}

/**
 * A plausible dance track: kick on 1 and the "and" of 2, snare on 2 and 4,
 * hats on every eighth, a sustained pad and some noise. The pad and noise make
 * sure detection is following rhythm, not just finding the only sound there is.
 */
function makeTrack(spec: TrackSpec): { data: Float32Array; sampleRate: number; downbeats: number[] } {
  const sr = spec.sampleRate ?? 44100;
  const n = Math.round(spec.seconds * sr);
  const data = new Float32Array(n);
  const rand = rng(Math.round(spec.bpm * 100));
  const beat = 60 / spec.bpm;
  const lead = spec.lead ?? 0;
  const downbeats: number[] = [];

  const add = (t0: number, dur: number, f: (t: number) => number) => {
    const a = Math.round(t0 * sr), b = Math.min(n, a + Math.round(dur * sr));
    for (let i = Math.max(0, a); i < b; i += 1) data[i] += f((i - a) / sr);
  };
  const kick = (t: number) => 0.9 * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 14);
  const snare = (t: number) => 0.45 * rand() * Math.exp(-t * 22) + 0.2 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 25);
  let hp = 0;
  const hat = (t: number) => { const v = rand(); const o = v - hp; hp = v; return 0.12 * o * Math.exp(-t * 80); };

  for (let k = 0; ; k += 1) {
    const t = lead + k * beat;
    if (t >= spec.seconds) break;
    const inBar = k % 4;
    if (inBar === 0) { add(t, 0.4, kick); downbeats.push(t); }
    if (inBar === 1) add(t + beat / 2, 0.4, kick);
    if (inBar === 1 || inBar === 3) add(t, 0.25, snare);
    add(t, 0.05, hat);
    add(t + beat / 2, 0.05, hat);
  }
  // Pad: a slow chord, entering with the music.
  for (let i = Math.round(lead * sr); i < n; i += 1) {
    const t = i / sr;
    data[i] += 0.08 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277 * t) + Math.sin(2 * Math.PI * 330 * t));
  }
  const noise = spec.noise ?? 0.02;
  for (let i = 0; i < n; i += 1) data[i] += noise * rand();
  return { data, sampleRate: sr, downbeats };
}

/** Distance from t to the nearest beat of the true grid, in seconds. */
function phaseError(t: number, firstBeat: number, bpm: number): number {
  const beat = 60 / bpm;
  const k = Math.round((t - firstBeat) / beat);
  return Math.abs(t - (firstBeat + k * beat));
}

console.log('tempo detection');
// Whether a song is "84" or "168" is a judgement a dancer makes, not a fact in
// the audio, so outside the common range half or double is accepted — the app
// offers ×2 / ÷2 for exactly this. What must always be right is the precision,
// and that every detected beat is a real beat.
const octaveOf = (detected: number, truth: number) =>
  [truth / 2, truth, truth * 2].reduce((a, b) => (Math.abs(b - detected) < Math.abs(a - detected) ? b : a));
for (const bpm of [84, 96, 100.5, 112, 123.4, 128, 140, 155]) {
  const track = makeTrack({ bpm, seconds: 60 });
  const r = detectTempo([track.data], track.sampleRate);
  if (bpm >= 92 && bpm <= 140) {
    check(`${bpm} BPM: tempo within 0.05`, () => near(r.bpm, bpm, 0.05, 'bpm'));
  } else {
    check(`${bpm} BPM: tempo within 0.05 of it, its half or its double (got ${r.bpm})`, () =>
      near(r.bpm, octaveOf(r.bpm, bpm), 0.05, 'bpm'));
  }
  check(`${bpm} BPM: beats line up within 15 ms`, () => assert.ok(phaseError(r.beatOne, 0, bpm) < 0.015, `${phaseError(r.beatOne, 0, bpm)}`));
}

{
  const track = makeTrack({ bpm: 118, seconds: 40 });
  const r = detectTempo([track.data], track.sampleRate);
  check('count 1 lands on the downbeat, not another beat of the bar', () =>
    assert.ok(track.downbeats.some((d) => Math.abs(d - r.beatOne) < 0.015), `${r.beatOne}`));
  check('a clear beat reports high confidence', () => assert.ok(r.confidence > 0.6, `${r.confidence}`));
}

{
  const track = makeTrack({ bpm: 104, seconds: 40, lead: 2.37 });
  const r = detectTempo([track.data], track.sampleRate);
  check('a silent lead-in is skipped: count 1 is the first downbeat', () => near(r.beatOne, 2.37, 0.015, 'beatOne'));
}

{
  const track = makeTrack({ bpm: 126, seconds: 40, sampleRate: 48000 });
  const r = detectTempo([track.data], track.sampleRate);
  check('48 kHz audio detects the same as 44.1 kHz', () => near(r.bpm, 126, 0.05, 'bpm'));
}

{
  // The real test of precision: a full-length song, where a small tempo error
  // compounds into a visibly wrong last chorus.
  const bpm = 121.7;
  const track = makeTrack({ bpm, seconds: 200 });
  const t0 = performance.now();
  const r = detectTempo([track.data], track.sampleRate);
  const ms = performance.now() - t0;
  const lastBeat = r.beatOne + Math.floor((199 - r.beatOne) / (60 / r.bpm)) * (60 / r.bpm);
  check('over a 200 s song the grid drifts less than 25 ms', () =>
    assert.ok(phaseError(lastBeat, 0, bpm) < 0.025, `${(phaseError(lastBeat, 0, bpm) * 1000).toFixed(1)} ms`));
  console.log(`      (200 s analysed in ${Math.round(ms)} ms)`);
}

{
  const rand = rng(7);
  const noise = new Float32Array(44100 * 20).map(() => 0.3 * rand());
  const r = detectTempo([noise], 44100);
  check('pure noise reports low confidence', () => assert.ok(r.confidence < 0.35, `${r.confidence}`));
  check('a clip too short to analyse falls back safely', () =>
    assert.equal(detectTempo([new Float32Array(44100)], 44100).confidence, 0));
}

console.log(`\n${n} checks passed`);
