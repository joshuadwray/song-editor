import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

const SR = 44100;

function writeWav(path, left, right) {
  const frames = left.length;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * 4, 40);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767))), o); o += 2;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767))), o); o += 2;
  }
  writeFileSync(path, buf);
  return frames / SR;
}

// A: one distinct tone per second. A cut is then trivially verifiable by
// checking which tones survive and where they land.
const TONES = [440, 554, 659, 880, 1109, 1319];
{
  const frames = SR * TONES.length;
  const L = new Float32Array(frames), R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const f = TONES[Math.floor(i / SR)];
    // Plucked envelope: never reaches zero, so zero-crossing analysis stays
    // valid, but the waveform has visible shape.
    const env = 0.25 + 0.7 * Math.exp(-3 * ((i % SR) / SR));
    const v = 0.85 * env * Math.sin(2 * Math.PI * f * (i / SR));
    L[i] = v; R[i] = v;
  }
  const d = writeWav(OUT + '/tones.wav', L, R);
  console.log(`tones.wav  ${d}s  tones/sec: ${TONES.join(', ')} Hz`);
}

// B: a centred 1000 Hz "vocal" over a hard-panned 300 Hz "instrument".
// Vocal reduction should remove the first and leave the second.
{
  const frames = SR * 4;
  const L = new Float32Array(frames), R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / SR;
    const vocal = 0.5 * Math.sin(2 * Math.PI * 1000 * t);   // identical in both = centred
    const side  = 0.4 * Math.sin(2 * Math.PI * 300 * t);    // inverted = pure side
    L[i] = vocal + side;
    R[i] = vocal - side;
  }
  const d = writeWav(OUT + '/stereo-vocal.wav', L, R);
  console.log(`stereo-vocal.wav  ${d}s  centred 1000 Hz + side 300 Hz`);
}
