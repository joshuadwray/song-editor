/** Main-thread wrapper around the MP3 encoding worker. */

import type { Mp3Response } from './mp3.worker';
import Mp3Worker from './mp3.worker?worker';

export const MP3_BITRATE = 192;

let nextId = 0;

export function encodeMp3(
  buffer: AudioBuffer,
  bitrate = MP3_BITRATE,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  const id = `mp3_${(nextId += 1)}`;

  // Copy before transferring: getChannelData returns a view into the
  // AudioBuffer, and transferring that view would detach the audio itself.
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    channels.push(new Float32Array(buffer.getChannelData(c)));
  }

  return new Promise((resolve, reject) => {
    // A fresh worker per export, terminated on completion, so a failed encode
    // cannot leave a wedged worker behind for the next one.
    const worker = new Mp3Worker();
    const finish = (fn: () => void) => {
      worker.terminate();
      fn();
    };

    worker.onmessage = (event: MessageEvent<Mp3Response>) => {
      const message = event.data;
      if (message.id !== id) return;
      if (message.type === 'progress') onProgress?.(message.progress);
      else if (message.type === 'done')
        finish(() => resolve(new Blob([message.bytes], { type: 'audio/mpeg' })));
      else finish(() => reject(new Error(message.message)));
    };
    worker.onerror = (event) => finish(() => reject(new Error(event.message)));

    worker.postMessage(
      { id, channels, sampleRate: buffer.sampleRate, bitrate },
      channels.map((c) => c.buffer),
    );
  });
}
