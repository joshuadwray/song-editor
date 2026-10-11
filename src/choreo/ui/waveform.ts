/**
 * Draws one 8-count's slice of the song into its own small canvas.
 *
 * Each 8-count is a column in the timeline, so the waveform is drawn per
 * column rather than as one long strip. Reads the peak pyramid Alainacity
 * already computes (src/waveform/peaks.worker.ts), so cost depends on the
 * column's pixel width, never on the song's length.
 */

import type { Peaks } from '../../waveform/peaks';

function levelFor(peaks: Peaks, samplesPerPixel: number): number {
  let chosen = 0;
  for (let i = 0; i < peaks.levels.length; i += 1) {
    if (peaks.levels[i].bucketSize <= samplesPerPixel) chosen = i;
  }
  return chosen;
}

/**
 * @param t0 song time at the column's left edge (may be negative: pre-roll)
 * @param t1 song time at the column's right edge (nominal 8-count length)
 * @param end where this 8-count really ends; beyond it the column is a gap
 */
export function drawColumn(
  canvas: HTMLCanvasElement,
  peaks: Peaks,
  t0: number,
  t1: number,
  end: number,
  colors: { wave: string; gap: string },
): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, w, h);

  const duration = peaks.length / peaks.sampleRate;
  const secPerPx = (t1 - t0) / w;
  const level = peaks.levels[levelFor(peaks, secPerPx * peaks.sampleRate)];
  const mid = h / 2;

  g.fillStyle = colors.wave;
  for (let x = 0; x < w; x += 1) {
    const a = t0 + x * secPerPx;
    const b = a + secPerPx;
    if (b <= 0 || a >= duration || a >= end) continue;
    const b0 = Math.max(0, Math.floor((a * peaks.sampleRate) / level.bucketSize));
    const b1 = Math.min(level.channels[0].max.length, Math.max(b0 + 1, Math.ceil((b * peaks.sampleRate) / level.bucketSize)));
    let lo = 0, hi = 0;
    for (const ch of level.channels) {
      for (let i = b0; i < b1; i += 1) {
        if (ch.min[i] < lo) lo = ch.min[i];
        if (ch.max[i] > hi) hi = ch.max[i];
      }
    }
    const top = mid - hi * mid * 0.95;
    const bottom = mid - lo * mid * 0.95;
    g.fillRect(x, top, 1, Math.max(1, bottom - top));
  }

  // Before the song starts, or after a splice cuts this 8-count short.
  g.fillStyle = colors.gap;
  const gapStart = Math.max(0, Math.min(w, ((Math.min(end, duration) - t0) / (t1 - t0)) * w));
  if (gapStart < w) g.fillRect(gapStart, 0, w - gapStart, h);
  if (t0 < 0) g.fillRect(0, 0, Math.min(w, (-t0 / (t1 - t0)) * w), h);
}
