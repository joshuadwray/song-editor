/**
 * Decoding and the registry of decoded audio.
 *
 * The registry is the only place raw samples live. It is deliberately outside
 * the Project so the Project stays JSON-serializable and undo stays cheap.
 */

import { AudioSource, newId } from '../model/project';

/** Decoded audio, keyed by SourceId. Never mutated after insertion. */
export class SourceRegistry {
  private buffers = new Map<string, AudioBuffer>();

  set(id: string, buffer: AudioBuffer): void {
    this.buffers.set(id, buffer);
  }

  get(id: string): AudioBuffer | undefined {
    return this.buffers.get(id);
  }

  has(id: string): boolean {
    return this.buffers.has(id);
  }

  delete(id: string): void {
    this.buffers.delete(id);
  }

  /** Drop everything — used when switching projects, to release the audio. */
  clear(): void {
    this.buffers.clear();
  }

  /** Approximate resident bytes, for the memory guardrail on low-RAM machines. */
  byteSize(): number {
    let total = 0;
    for (const buf of this.buffers.values()) {
      total += buf.length * buf.numberOfChannels * 4;
    }
    return total;
  }
}

export interface DecodedFile {
  source: AudioSource;
  buffer: AudioBuffer;
}

/**
 * Decode a file the browser can read. Chrome handles mp3, wav, flac, ogg and
 * m4a here natively — this is exactly the codec support we would otherwise
 * have had to ship ourselves.
 */
export async function decodeAudio(
  data: Blob,
  name: string,
  ctx: BaseAudioContext,
): Promise<AudioBuffer> {
  // decodeAudioData detaches the buffer it is given, so callers that also need
  // the bytes (to store them) must read the Blob separately.
  const bytes = await data.arrayBuffer();
  try {
    return await ctx.decodeAudioData(bytes);
  } catch {
    throw new Error(
      `Could not read "${name}". It may be a format this browser does not support, or the file may be damaged.`,
    );
  }
}

export async function decodeFile(file: File, ctx: BaseAudioContext): Promise<DecodedFile> {
  const buffer = await decodeAudio(file, file.name, ctx);
  const source: AudioSource = {
    id: newId('src'),
    name: file.name.replace(/\.[^.]+$/, ''),
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    duration: buffer.duration,
  };
  return { source, buffer };
}
