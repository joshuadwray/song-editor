/**
 * Canvas rendering for the timeline.
 *
 * Colours follow Audacity's classic light theme deliberately — the point of
 * this project is that it looks like the tool she already knows.
 */

import { Clip, Track, clipEnd } from '../model/project';
import { SourceRegistry } from '../audio/decode';
import type { Peaks } from './peaks';

export const COLORS = {
  trackBg: '#ededed',
  trackBgSelected: '#d2d2e8',
  clipBg: '#ffffff',
  clipBgSelected: '#dcdcf0',
  peak: '#3232c8',
  rms: '#6f6fdc',
  centerLine: '#9a9aa8',
  clipBorder: '#8f8fa8',
  rulerBg: '#e4e4e8',
  rulerText: '#333340',
  rulerTick: '#7a7a88',
  playhead: '#c81e1e',
  cursor: '#404050',
  effectTint: 'rgba(224, 148, 32, 0.20)',
  effectBar: '#c07818',
  effectText: '#5a3708',
  snapGuide: '#e08000',
};

export interface View {
  /** Project time at the left edge of the canvas. */
  start: number;
  pxPerSec: number;
}

export interface Selection {
  start: number;
  end: number;
  /** null means "all tracks". */
  trackIds: string[] | null;
}

export function timeToX(time: number, view: View): number {
  return (time - view.start) * view.pxPerSec;
}

export function xToTime(x: number, view: View): number {
  return view.start + x / view.pxPerSec;
}

/** Largest pyramid level whose buckets still fit inside one pixel column. */
function pickLevel(peaks: Peaks, samplesPerPixel: number): number {
  let chosen = -1;
  for (let i = 0; i < peaks.levels.length; i += 1) {
    if (peaks.levels[i].bucketSize <= samplesPerPixel) chosen = i;
    else break;
  }
  return chosen;
}

interface ColumnStat {
  min: number;
  max: number;
  rms: number;
}

function statFromPeaks(
  peaks: Peaks,
  levelIndex: number,
  channel: number,
  s0: number,
  s1: number,
): ColumnStat {
  const level = peaks.levels[levelIndex];
  const ch = level.channels[Math.min(channel, level.channels.length - 1)];
  const b0 = Math.max(0, Math.floor(s0 / level.bucketSize));
  const b1 = Math.min(ch.min.length, Math.max(b0 + 1, Math.ceil(s1 / level.bucketSize)));

  let min = Infinity;
  let max = -Infinity;
  let sumSquares = 0;
  for (let b = b0; b < b1; b += 1) {
    if (ch.min[b] < min) min = ch.min[b];
    if (ch.max[b] > max) max = ch.max[b];
    sumSquares += ch.rms[b] * ch.rms[b];
  }
  const n = Math.max(1, b1 - b0);
  return {
    min: min === Infinity ? 0 : min,
    max: max === -Infinity ? 0 : max,
    rms: Math.sqrt(sumSquares / n),
  };
}

/** Zoomed in past the finest pyramid level, so read the samples directly. */
function statFromSamples(data: Float32Array, s0: number, s1: number): ColumnStat {
  const start = Math.max(0, Math.floor(s0));
  const end = Math.min(data.length, Math.max(start + 1, Math.ceil(s1)));
  let min = Infinity;
  let max = -Infinity;
  let sumSquares = 0;
  for (let i = start; i < end; i += 1) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sumSquares += v * v;
  }
  const n = Math.max(1, end - start);
  return {
    min: min === Infinity ? 0 : min,
    max: max === -Infinity ? 0 : max,
    rms: Math.sqrt(sumSquares / n),
  };
}

/**
 * Gain the clip's fade envelope applies at a given offset into the clip.
 *
 * Must match applyEnvelope() in audio/graph.ts — if the drawing and the sound
 * disagree about a fade, the waveform is lying.
 */
function fadeGainAt(clip: Clip, tInClip: number, duration: number): number {
  let gain = 1;
  if (clip.fadeIn > 0) gain *= Math.min(1, Math.max(0, tInClip / clip.fadeIn));
  if (clip.fadeOut > 0) gain *= Math.min(1, Math.max(0, (duration - tInClip) / clip.fadeOut));
  return gain;
}

function drawClipWaveform(
  g: CanvasRenderingContext2D,
  clip: Clip,
  peaks: Peaks | undefined,
  buffer: AudioBuffer | undefined,
  view: View,
  x0: number,
  x1: number,
  top: number,
  height: number,
): void {
  if (!peaks && !buffer) return;
  const sampleRate = peaks?.sampleRate ?? buffer!.sampleRate;
  const channels = peaks?.levels[0].channels.length ?? buffer!.numberOfChannels;
  const laneHeight = height / channels;
  const samplesPerPixel = sampleRate / view.pxPerSec;
  const levelIndex = peaks ? pickLevel(peaks, samplesPerPixel) : -1;
  const clipDur = clip.sourceEnd - clip.sourceStart;
  const faded = clip.fadeIn > 0 || clip.fadeOut > 0;

  for (let c = 0; c < channels; c += 1) {
    const laneTop = top + c * laneHeight;
    const mid = laneTop + laneHeight / 2;
    const amp = (laneHeight / 2) * 0.92;
    const data = levelIndex < 0 && buffer ? buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)) : null;

    // Zero line first, so quiet passages still read as audio rather than a gap.
    g.fillStyle = COLORS.centerLine;
    g.fillRect(x0, Math.round(mid), x1 - x0, 1);

    for (let x = Math.floor(x0); x < x1; x += 1) {
      const tLeft = xToTime(x, view) - clip.timelineStart + clip.sourceStart;
      const tRight = xToTime(x + 1, view) - clip.timelineStart + clip.sourceStart;
      const s0 = tLeft * sampleRate;
      const s1 = tRight * sampleRate;

      const stat =
        data !== null
          ? statFromSamples(data, s0, s1)
          : statFromPeaks(peaks!, Math.max(0, levelIndex), c, s0, s1);

      // Draw the fade into the waveform itself, the way Audacity does, so the
      // shape on screen is the shape she will hear.
      const envelope = faded
        ? fadeGainAt(clip, xToTime(x + 0.5, view) - clip.timelineStart, clipDur)
        : 1;

      const yMax = mid - stat.max * envelope * amp;
      const yMin = mid - stat.min * envelope * amp;
      g.fillStyle = COLORS.peak;
      g.fillRect(x, yMax, 1, Math.max(1, yMin - yMax));

      const rmsPx = stat.rms * envelope * amp;
      if (rmsPx > 0.5) {
        g.fillStyle = COLORS.rms;
        g.fillRect(x, mid - rmsPx, 1, Math.max(1, rmsPx * 2));
      }
    }
  }
}

function effectLabel(effect: Clip['effects'][number]): string {
  switch (effect.type) {
    case 'vocalReduce':
      return 'vocals reduced';
    case 'silence':
      return 'silenced';
    case 'duck':
      return 'quieter';
    case 'muffle':
      return 'muffled';
  }
}

export interface DrawTrackOptions {
  track: Track;
  peaks: Map<string, Peaks>;
  registry: SourceRegistry;
  view: View;
  width: number;
  height: number;
  selection: Selection | null;
}

export function drawTrack(g: CanvasRenderingContext2D, opts: DrawTrackOptions): void {
  const { track, peaks, registry, view, width, height, selection } = opts;

  g.fillStyle = COLORS.trackBg;
  g.fillRect(0, 0, width, height);

  const selected =
    selection &&
    selection.end > selection.start &&
    (selection.trackIds === null || selection.trackIds.includes(track.id));
  const selX0 = selected ? Math.max(0, timeToX(selection!.start, view)) : 0;
  const selX1 = selected ? Math.min(width, timeToX(selection!.end, view)) : 0;

  if (selected && selX1 > selX0) {
    g.fillStyle = COLORS.trackBgSelected;
    g.fillRect(selX0, 0, selX1 - selX0, height);
  }

  for (const clip of track.clips) {
    const x0 = timeToX(clip.timelineStart, view);
    const x1 = timeToX(clipEnd(clip), view);
    if (x1 < 0 || x0 > width) continue;

    const vx0 = Math.max(0, Math.floor(x0));
    const vx1 = Math.min(width, Math.ceil(x1));
    if (vx1 <= vx0) continue;

    // Clip body sits above the track background so gaps stay visibly empty.
    // Always paint the unselected colour first: tinting the whole clip when it
    // merely overlaps the selection would make every edit look global.
    g.fillStyle = COLORS.clipBg;
    g.fillRect(vx0, 0, vx1 - vx0, height);

    if (selected && selX1 > selX0) {
      const ox0 = Math.max(vx0, selX0);
      const ox1 = Math.min(vx1, selX1);
      if (ox1 > ox0) {
        g.fillStyle = COLORS.clipBgSelected;
        g.fillRect(ox0, 0, ox1 - ox0, height);
      }
    }

    drawClipWaveform(
      g,
      clip,
      peaks.get(clip.sourceId),
      registry.get(clip.sourceId),
      view,
      vx0,
      vx1,
      0,
      height,
    );

    if (clip.effects.length > 0) {
      g.fillStyle = COLORS.effectTint;
      g.fillRect(vx0, 0, vx1 - vx0, height);
      g.fillStyle = COLORS.effectBar;
      g.fillRect(vx0, 0, vx1 - vx0, 3);

      // Name the effect when the region is wide enough to read.
      const label = effectLabel(clip.effects[0]);
      g.font = '10px system-ui, -apple-system, sans-serif';
      if (vx1 - vx0 > g.measureText(label).width + 10) {
        g.fillStyle = COLORS.effectText;
        g.textBaseline = 'top';
        g.fillText(label, vx0 + 4, 6);
      }
    }

    // Seams between clips are meaningful — they are where cuts happened.
    g.fillStyle = COLORS.clipBorder;
    g.fillRect(vx0, 0, 1, height);
    g.fillRect(vx1 - 1, 0, 1, height);
  }
}

/** Choose a tick interval that lands on a round number of seconds or minutes. */
function tickInterval(pxPerSec: number): number {
  const targetPx = 90;
  const candidates = [
    0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
  ];
  for (const c of candidates) {
    if (c * pxPerSec >= targetPx) return c;
  }
  return candidates[candidates.length - 1];
}

export function formatTime(seconds: number, precise = false): string {
  const sign = seconds < 0 ? '-' : '';
  const s = Math.abs(seconds);
  const mins = Math.floor(s / 60);
  const secs = s - mins * 60;
  if (precise) return `${sign}${mins}:${secs.toFixed(3).padStart(6, '0')}`;
  return `${sign}${mins}:${Math.floor(secs).toString().padStart(2, '0')}`;
}

export function drawRuler(
  g: CanvasRenderingContext2D,
  view: View,
  width: number,
  height: number,
): void {
  g.fillStyle = COLORS.rulerBg;
  g.fillRect(0, 0, width, height);

  const interval = tickInterval(view.pxPerSec);
  const first = Math.floor(view.start / interval) * interval;
  const showSubsecond = interval < 1;

  g.font = '11px system-ui, -apple-system, sans-serif';
  g.textBaseline = 'alphabetic';

  for (let t = first; ; t += interval) {
    const x = Math.round(timeToX(t, view));
    if (x > width) break;
    if (x < -50) continue;
    if (t < 0) continue;

    g.fillStyle = COLORS.rulerTick;
    g.fillRect(x, height - 8, 1, 8);
    g.fillStyle = COLORS.rulerText;
    g.fillText(formatTime(t, showSubsecond), x + 3, height - 10);
  }

  g.fillStyle = COLORS.rulerTick;
  g.fillRect(0, height - 1, width, 1);
}
