/**
 * Offline render.
 *
 * Rebuilds the identical node graph inside an OfflineAudioContext and renders
 * faster than real time. Reusing graph.ts here rather than reimplementing the
 * mix is what guarantees the export matches playback.
 */

import { Project, audibleTracks, projectDuration } from '../../model/project';
import { SourceRegistry } from '../decode';
import { scheduleClip } from '../graph';

export async function renderProject(
  project: Project,
  registry: SourceRegistry,
  options: { sampleRate?: number; range?: { start: number; end: number } } = {},
): Promise<AudioBuffer> {
  const tracks = audibleTracks(project);
  const start = options.range?.start ?? 0;
  const end = options.range?.end ?? projectDuration(project);
  const duration = end - start;
  if (duration <= 0) throw new Error('There is nothing to export.');

  // Default to the sample rate of the material rather than resampling it.
  const first = Object.values(project.sources)[0];
  const sampleRate = options.sampleRate ?? first?.sampleRate ?? 44100;

  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.connect(ctx.destination);

  for (const track of tracks) {
    const gain = ctx.createGain();
    gain.gain.value = track.gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = track.pan;
    gain.connect(panner).connect(master);

    for (const clip of track.clips) {
      const buffer = registry.get(clip.sourceId);
      if (!buffer) continue;

      const clipStart = clip.timelineStart;
      const clipStop = clipStart + (clip.sourceEnd - clip.sourceStart);
      if (clipStop <= start || clipStart >= end) continue;

      // Offline time is relative to the start of the exported range.
      const soundStart = Math.max(clipStart, start);
      scheduleClip(ctx, clip, buffer, gain, soundStart - start, soundStart - clipStart);
    }
  }

  return ctx.startRendering();
}
