/**
 * MP3 encoding.
 *
 * Browsers decode mp3 natively but encode nothing, so this is the one place a
 * codec has to be shipped. It runs in a worker because encoding a five-minute
 * song takes seconds, and doing that on the main thread would freeze the UI
 * mid-export — which reads as a crash.
 */

import { Mp3Encoder } from '@breezystack/lamejs';

/** One MPEG frame. lamejs expects input in these units. */
const FRAME = 1152;

export interface Mp3Request {
  id: string;
  channels: Float32Array[];
  sampleRate: number;
  bitrate: number;
}

export type Mp3Response =
  | { id: string; type: 'progress'; progress: number }
  | { id: string; type: 'done'; bytes: ArrayBuffer }
  | { id: string; type: 'error'; message: string };

/**
 * Float samples to 16-bit.
 *
 * Clamping first matters: summed tracks can exceed unity, and letting that
 * wrap turns a mild overload into loud digital noise.
 */
function toInt16(source: Float32Array, start: number, length: number): Int16Array {
  const out = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const sample = source[start + i] ?? 0;
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

self.onmessage = (event: MessageEvent<Mp3Request>) => {
  const { id, channels, sampleRate, bitrate } = event.data;
  const post = (message: Mp3Response, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(message, transfer ?? []);

  try {
    const channelCount = Math.min(2, channels.length);
    const encoder = new Mp3Encoder(channelCount, sampleRate, bitrate);
    const total = channels[0].length;
    const parts: Uint8Array[] = [];
    let size = 0;

    for (let offset = 0; offset < total; offset += FRAME) {
      const length = Math.min(FRAME, total - offset);
      const left = toInt16(channels[0], offset, length);
      const chunk =
        channelCount === 2
          ? encoder.encodeBuffer(left, toInt16(channels[1], offset, length))
          : encoder.encodeBuffer(left);
      if (chunk.length > 0) {
        parts.push(chunk);
        size += chunk.length;
      }
      // Roughly every half second of audio; frequent enough to look alive,
      // rare enough not to flood the main thread with messages.
      if ((offset / FRAME) % 20 === 0) {
        post({ id, type: 'progress', progress: offset / total });
      }
    }

    const tail = encoder.flush();
    if (tail.length > 0) {
      parts.push(tail);
      size += tail.length;
    }

    const bytes = new Uint8Array(size);
    let cursor = 0;
    for (const part of parts) {
      bytes.set(part, cursor);
      cursor += part.length;
    }

    post({ id, type: 'done', bytes: bytes.buffer as ArrayBuffer }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
