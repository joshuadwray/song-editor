/**
 * Tempo and beat-phase detection.
 *
 * Gets the grid close enough that she only has to confirm it, not build it.
 * She will always have "count 1 here", nudge and tap tempo as the final word;
 * this just has to be right often enough that those are corrections rather
 * than the main workflow.
 *
 * Precision is the part that matters. A grid 0.1 BPM off has drifted a third
 * of a beat by the end of a three-minute song, which reads as "the counts are
 * wrong" even though they started right. So after a coarse estimate, the tempo
 * is refined by folding the whole song's onsets at candidate periods to 0.01
 * BPM.
 *
 * Pure: takes samples, returns numbers. Runs in a worker in the app and in
 * Node in the tests.
 */

export interface TempoResult {
  bpm: number;
  /** Time of a beat chosen as count 1: the first strong beat after the music starts. */
  beatOne: number;
  /** 0..1, how periodic the onsets are at this tempo. Low means "check this". */
  confidence: number;
}

export const DETECT_MIN_BPM = 70;
export const DETECT_MAX_BPM = 180;

const FRAME = 512;
const TARGET_RATE = 11025;

/** Mix to mono and drop to ~11 kHz: beats live well below 5 kHz. */
function prepare(channels: Float32Array[], sampleRate: number): { x: Float32Array; rate: number } {
  const factor = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const n = Math.floor(channels[0].length / factor);
  const x = new Float32Array(n);
  const scale = 1 / (factor * channels.length);
  for (let i = 0; i < n; i += 1) {
    let s = 0;
    const base = i * factor;
    for (const ch of channels) for (let k = 0; k < factor; k += 1) s += ch[base + k];
    x[i] = s * scale;
  }
  return { x, rate: sampleRate / factor };
}

/** In-place iterative radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

interface Envelope {
  /** Spectral-flux onset strength, one value per hop. */
  full: Float32Array;
  /** The same, below ~200 Hz: kicks, which tend to mark count 1. */
  low: Float32Array;
  /** RMS per hop, for finding where the music starts. */
  rms: Float32Array;
  /** Hops per second. */
  rate: number;
  /** Seconds from a hop index to the time it describes. */
  offset: number;
}

function onsetEnvelope(x: Float32Array, rate: number): Envelope {
  const hop = Math.max(1, Math.round(rate * 0.0116));
  const frames = Math.max(0, Math.floor((x.length - FRAME) / hop));
  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  const bins = FRAME / 2;
  const lowBins = Math.max(2, Math.round((200 * FRAME) / rate));

  const full = new Float32Array(frames);
  const low = new Float32Array(frames);
  const rms = new Float32Array(frames);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);

  for (let f = 0; f < frames; f += 1) {
    const base = f * hop;
    let energy = 0;
    for (let i = 0; i < FRAME; i += 1) {
      const v = x[base + i];
      energy += v * v;
      re[i] = v * window[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(energy / FRAME);
    fft(re, im);
    let fluxAll = 0, fluxLow = 0;
    for (let k = 1; k < bins; k += 1) {
      // Log compression, so a quiet hi-hat still registers next to a loud kick.
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = cur[k] - prev[k];
      if (d > 0) {
        fluxAll += d;
        if (k < lowBins) fluxLow += d;
      }
    }
    full[f] = f === 0 ? 0 : fluxAll;
    low[f] = f === 0 ? 0 : fluxLow;
    [prev, cur] = [cur, prev];
  }

  return {
    full: highPass(full, Math.round(0.4 * (rate / hop))),
    low: highPass(low, Math.round(0.4 * (rate / hop))),
    rms,
    rate: rate / hop,
    // A frame's flux rises when the onset enters it; centring the attribution
    // on the frame lines the beat up with the attack rather than ahead of it.
    offset: FRAME / 2 / rate,
  };
}

/** Subtract a moving average and keep only the rises: leaves the onsets. */
function highPass(e: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(e.length);
  const prefix = new Float64Array(e.length + 1);
  for (let i = 0; i < e.length; i += 1) prefix[i + 1] = prefix[i] + e[i];
  for (let i = 0; i < e.length; i += 1) {
    const a = Math.max(0, i - radius), b = Math.min(e.length, i + radius + 1);
    const mean = (prefix[b] - prefix[a]) / (b - a);
    out[i] = Math.max(0, e[i] - mean);
  }
  return out;
}

/** Coarse tempo: autocorrelation, weighted toward tempos people dance to. */
function coarseBpm(env: Float32Array, rate: number): number {
  const minLag = Math.floor((60 * rate) / DETECT_MAX_BPM);
  const maxLag = Math.ceil((60 * rate) / DETECT_MIN_BPM);
  const ac = new Float64Array(maxLag + 2);
  for (let lag = 1; lag < ac.length && lag < env.length; lag += 1) {
    let s = 0;
    for (let i = lag; i < env.length; i += 1) s += env[i] * env[i - lag];
    ac[lag] = s / (env.length - lag);
  }
  let best = minLag, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const score = ac[lag];
    const bpm = (60 * rate) / lag;
    // Preference for ~115 BPM resolves the half/double ambiguity the way
    // a dancer counts most music. She can still halve or double it.
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.6) ** 2);
    if (score * weight > bestScore) {
      bestScore = score * weight;
      best = lag;
    }
  }
  // Sub-lag precision from the neighbours.
  const y0 = ac[best - 1], y1 = ac[best], y2 = ac[best + 1];
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  return (60 * rate) / (best + Math.max(-0.5, Math.min(0.5, shift)));
}

const PHASE_BINS = 96;

/**
 * Fold the envelope at a beat period: if the period is right, every beat lands
 * in the same phase bin and makes a sharp peak; if it is slightly off, they
 * smear. Sharpness of the folded peak is the score.
 */
function fold(env: Float32Array, period: number): Float64Array {
  const hist = new Float64Array(PHASE_BINS);
  for (let i = 0; i < env.length; i += 1) {
    const v = env[i];
    if (v === 0) continue;
    const p = (i / period) % 1;
    const pos = p * PHASE_BINS;
    const b0 = Math.floor(pos);
    const w = pos - b0;
    hist[b0 % PHASE_BINS] += v * (1 - w);
    hist[(b0 + 1) % PHASE_BINS] += v * w;
  }
  return hist;
}

function peakOf(hist: Float64Array): { bin: number; value: number; mean: number } {
  let best = 0, value = -Infinity, sum = 0;
  for (let b = 0; b < PHASE_BINS; b += 1) {
    sum += hist[b];
    // Smooth over neighbours so one noisy bin cannot win.
    const v = hist[(b + PHASE_BINS - 1) % PHASE_BINS] * 0.5 + hist[b] + hist[(b + 1) % PHASE_BINS] * 0.5;
    if (v > value) { value = v; best = b; }
  }
  return { bin: best, value, mean: (sum / PHASE_BINS) * 2 };
}

function refine(env: Float32Array, rate: number, bpm: number): { bpm: number; phase: number; sharpness: number } {
  let best = { bpm, phase: 0, sharpness: -Infinity };
  // Coarse to fine: ±3 BPM at 0.05, then ±0.06 at 0.002.
  for (const [span, step] of [[3, 0.05], [0.06, 0.002]] as const) {
    const centre = best.sharpness === -Infinity ? bpm : best.bpm;
    for (let b = centre - span; b <= centre + span + 1e-9; b += step) {
      const period = (60 * rate) / b;
      const pk = peakOf(fold(env, period));
      const sharpness = pk.value / (pk.mean || 1);
      if (sharpness > best.sharpness) {
        // Parabolic interpolation across the peak bin for sub-bin phase.
        const h = fold(env, period);
        const l = h[(pk.bin + PHASE_BINS - 1) % PHASE_BINS], c = h[pk.bin], r = h[(pk.bin + 1) % PHASE_BINS];
        const d = l - 2 * c + r;
        const off = d !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / d)) : 0;
        best = { bpm: b, phase: ((pk.bin + off) / PHASE_BINS) * period, sharpness };
      }
    }
  }
  return best;
}

export function detectTempo(channels: Float32Array[], sampleRate: number): TempoResult {
  const { x, rate } = prepare(channels, sampleRate);
  const env = onsetEnvelope(x, rate);
  if (env.full.length < env.rate * 4) {
    return { bpm: 120, beatOne: 0, confidence: 0 };
  }

  const coarse = coarseBpm(env.full, env.rate);
  const { bpm, phase, sharpness } = refine(env.full, env.rate, coarse);
  const period = (60 * env.rate) / bpm;
  const beatSec = 60 / bpm;
  const firstBeat = phase / env.rate + env.offset;

  // Where the music starts: first hop within 30 dB of the loudest.
  let peakRms = 0;
  for (const v of env.rms) peakRms = Math.max(peakRms, v);
  let startHop = 0;
  while (startHop < env.rms.length && env.rms[startHop] < peakRms * 0.0316) startHop += 1;
  const musicStart = startHop / env.rate;

  // Count 1 is usually where the kick is heaviest, so pick the beat-of-four
  // with the most low-end onset energy.
  const lowHist = new Float64Array(4);
  for (let k = 0; ; k += 1) {
    const idx = Math.round(phase + k * period);
    if (idx >= env.low.length) break;
    let s = 0;
    for (let j = -1; j <= 1; j += 1) s += env.low[Math.min(env.low.length - 1, Math.max(0, idx + j))];
    lowHist[k % 4] += s;
  }
  let strongest = 0;
  for (let j = 1; j < 4; j += 1) if (lowHist[j] > lowHist[strongest]) strongest = j;

  let beatOne = firstBeat + strongest * beatSec;
  while (beatOne - 4 * beatSec >= musicStart - beatSec * 0.5) beatOne -= 4 * beatSec;
  while (beatOne < musicStart - beatSec * 0.5) beatOne += 4 * beatSec;

  // Map sharpness (~1 for noise, 3+ for a clear beat) onto 0..1.
  const confidence = Math.max(0, Math.min(1, (sharpness - 1.2) / 2.5));
  return { bpm: Math.round(bpm * 100) / 100, beatOne, confidence };
}
