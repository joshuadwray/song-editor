/**
 * Fixture for the choreography app: a short dance track at a known tempo.
 *
 * Kick on 1 and the "and" of 2, snare on 2 and 4, hats on the eighths, a pad,
 * and some noise — enough rhythm for tempo detection to have to work, with a
 * ground truth to check it against. Matches makeTrack() in
 * test/choreo-model.test.ts.
 */

import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
const SR = 44100;

export const CHOREO_SONG = { file: 'choreo-song.wav', bpm: 118, lead: 1.0, seconds: 45 };

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
}

function makeTrack({ bpm, seconds, lead }) {
  const n = Math.round(seconds * SR);
  const data = new Float32Array(n);
  const rand = rng(Math.round(bpm * 100));
  const beat = 60 / bpm;
  const add = (t0, dur, f) => {
    const a = Math.round(t0 * SR), b = Math.min(n, a + Math.round(dur * SR));
    for (let i = Math.max(0, a); i < b; i += 1) data[i] += f((i - a) / SR);
  };
  const kick = (t) => 0.9 * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 14);
  const snare = (t) => 0.45 * rand() * Math.exp(-t * 22) + 0.2 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 25);
  let hp = 0;
  const hat = (t) => { const v = rand(); const o = v - hp; hp = v; return 0.12 * o * Math.exp(-t * 80); };
  for (let k = 0; ; k += 1) {
    const t = lead + k * beat;
    if (t >= seconds) break;
    const inBar = k % 4;
    if (inBar === 0) add(t, 0.4, kick);
    if (inBar === 1) add(t + beat / 2, 0.4, kick);
    if (inBar === 1 || inBar === 3) add(t, 0.25, snare);
    add(t, 0.05, hat);
    add(t + beat / 2, 0.05, hat);
  }
  for (let i = Math.round(lead * SR); i < n; i += 1) {
    const t = i / SR;
    data[i] += 0.08 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277 * t) + Math.sin(2 * Math.PI * 330 * t));
  }
  for (let i = 0; i < n; i += 1) data[i] += 0.02 * rand();
  return data;
}

function writeWav(path, mono) {
  const frames = mono.length;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * 4, 40);
  let o = 44;
  for (let i = 0; i < frames; i += 1) {
    const v = Math.max(-32768, Math.min(32767, Math.round(mono[i] * 0.8 * 32767)));
    buf.writeInt16LE(v, o); buf.writeInt16LE(v, o + 2); o += 4;
  }
  writeFileSync(path, buf);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeWav(`${OUT}/${CHOREO_SONG.file}`, makeTrack(CHOREO_SONG));
  console.log(`${CHOREO_SONG.file}  ${CHOREO_SONG.seconds}s at ${CHOREO_SONG.bpm} BPM, first downbeat ${CHOREO_SONG.lead}s`);
}
