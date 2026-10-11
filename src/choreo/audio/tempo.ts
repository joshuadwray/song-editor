/** Main-thread wrapper around the tempo worker. */

import type { TempoResult } from '../model/tempo';
import TempoWorker from './tempo.worker?worker';

export function analyseTempo(buffer: AudioBuffer): Promise<TempoResult> {
  // Copies, not views: transferring a view would detach the song's own audio.
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    channels.push(new Float32Array(buffer.getChannelData(c)));
  }
  const worker = new TempoWorker();
  return new Promise<TempoResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<TempoResult>) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage(
      { channels, sampleRate: buffer.sampleRate },
      channels.map((c) => c.buffer),
    );
  }).finally(() => worker.terminate());
}
