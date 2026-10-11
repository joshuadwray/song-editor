/** Runs tempo detection off the main thread: a full song takes about a second on a Chromebook. */

import { detectTempo } from '../model/tempo';

self.onmessage = (event: MessageEvent<{ channels: Float32Array[]; sampleRate: number }>) => {
  const { channels, sampleRate } = event.data;
  (self as unknown as Worker).postMessage(detectTempo(channels, sampleRate));
};
