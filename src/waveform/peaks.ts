/** Main-thread wrapper around the peak worker. */

import type { Peaks } from './peaks.worker';
import PeaksWorker from './peaks.worker?worker';

export type { Peaks, PeakLevel, ChannelPeaks } from './peaks.worker';

let worker: Worker | null = null;
let nextId = 0;

function ensureWorker(): Worker {
  if (!worker) worker = new PeaksWorker();
  return worker;
}

export function computePeaks(buffer: AudioBuffer): Promise<Peaks> {
  const w = ensureWorker();
  const id = `peaks_${(nextId += 1)}`;

  // Copy before transferring: getChannelData returns a view into the
  // AudioBuffer, and transferring that view would detach the audio itself.
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    channels.push(new Float32Array(buffer.getChannelData(c)));
  }

  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<{ id: string; peaks: Peaks }>) => {
      if (event.data.id !== id) return;
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      resolve(event.data.peaks);
    };
    const onError = (event: ErrorEvent) => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      reject(new Error(event.message));
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage(
      { id, channels, sampleRate: buffer.sampleRate },
      channels.map((c) => c.buffer),
    );
  });
}
