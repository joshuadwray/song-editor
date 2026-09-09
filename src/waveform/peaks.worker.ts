/**
 * Peak pyramid computation.
 *
 * Drawing a five-minute file by walking raw samples stutters badly on a
 * low-end Chromebook, and stutter reads as instability. Precomputing min/max/RMS
 * at several decimations makes drawing cost depend on the width of the canvas
 * instead of the length of the audio.
 *
 * Runs in a worker so importing a file never blocks the UI.
 */

export interface ChannelPeaks {
  min: Float32Array;
  max: Float32Array;
  rms: Float32Array;
}

export interface PeakLevel {
  bucketSize: number;
  channels: ChannelPeaks[];
}

export interface Peaks {
  sampleRate: number;
  length: number;
  levels: PeakLevel[];
}

/** Base bucket, then four more levels each 4x coarser. */
const BASE_BUCKET = 256;
const LEVELS = 5;

function baseLevel(channels: Float32Array[]): PeakLevel {
  const buckets = Math.ceil(channels[0].length / BASE_BUCKET);
  const out: ChannelPeaks[] = channels.map(() => ({
    min: new Float32Array(buckets),
    max: new Float32Array(buckets),
    rms: new Float32Array(buckets),
  }));

  for (let c = 0; c < channels.length; c += 1) {
    const data = channels[c];
    const dst = out[c];
    for (let b = 0; b < buckets; b += 1) {
      const start = b * BASE_BUCKET;
      const end = Math.min(start + BASE_BUCKET, data.length);
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
      dst.min[b] = min === Infinity ? 0 : min;
      dst.max[b] = max === -Infinity ? 0 : max;
      dst.rms[b] = Math.sqrt(sumSquares / n);
    }
  }
  return { bucketSize: BASE_BUCKET, channels: out };
}

/**
 * Coarser levels aggregate the level below rather than rescanning the samples,
 * so building the whole pyramid costs barely more than the base level.
 */
function coarsen(level: PeakLevel, factor: number): PeakLevel {
  const srcBuckets = level.channels[0].min.length;
  const buckets = Math.ceil(srcBuckets / factor);
  const out: ChannelPeaks[] = level.channels.map(() => ({
    min: new Float32Array(buckets),
    max: new Float32Array(buckets),
    rms: new Float32Array(buckets),
  }));

  for (let c = 0; c < level.channels.length; c += 1) {
    const src = level.channels[c];
    const dst = out[c];
    for (let b = 0; b < buckets; b += 1) {
      const start = b * factor;
      const end = Math.min(start + factor, srcBuckets);
      let min = Infinity;
      let max = -Infinity;
      let sumSquares = 0;
      for (let i = start; i < end; i += 1) {
        if (src.min[i] < min) min = src.min[i];
        if (src.max[i] > max) max = src.max[i];
        // Equal-sized buckets, so the mean of the squares is exact.
        sumSquares += src.rms[i] * src.rms[i];
      }
      const n = Math.max(1, end - start);
      dst.min[b] = min === Infinity ? 0 : min;
      dst.max[b] = max === -Infinity ? 0 : max;
      dst.rms[b] = Math.sqrt(sumSquares / n);
    }
  }
  return { bucketSize: level.bucketSize * factor, channels: out };
}

interface Request {
  id: string;
  channels: Float32Array[];
  sampleRate: number;
}

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, channels, sampleRate } = event.data;

  const levels: PeakLevel[] = [baseLevel(channels)];
  for (let i = 1; i < LEVELS; i += 1) {
    levels.push(coarsen(levels[i - 1], 4));
  }

  const peaks: Peaks = { sampleRate, length: channels[0].length, levels };

  // Hand the arrays over rather than copying them back across the boundary.
  const transfer: ArrayBuffer[] = [];
  for (const level of levels) {
    for (const ch of level.channels) {
      transfer.push(
        ch.min.buffer as ArrayBuffer,
        ch.max.buffer as ArrayBuffer,
        ch.rms.buffer as ArrayBuffer,
      );
    }
  }
  (self as unknown as Worker).postMessage({ id, peaks }, transfer);
};
