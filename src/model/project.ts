/**
 * The project model.
 *
 * Invariant: decoded audio is IMMUTABLE. Nothing in this file ever touches
 * samples. Every edit is a metadata change over ranges of a source, which is
 * what keeps undo cheap (JSON snapshots) and memory bounded (one decoded copy
 * per imported file, regardless of how many edits reference it).
 *
 * Everything here must stay JSON-serializable — it is the project save format.
 * Decoded AudioBuffers live separately, in SourceRegistry (audio/decode.ts).
 */

export type SourceId = string;
export type TrackId = string;
export type ClipId = string;

/** Metadata for an imported file. The samples themselves live in SourceRegistry. */
export interface AudioSource {
  id: SourceId;
  name: string;
  sampleRate: number;
  channels: number;
  /** Full duration of the source file in seconds. */
  duration: number;
}

export type Effect =
  | { type: 'vocalReduce'; amount: number; lowHz: number; highHz: number }
  | { type: 'silence' }
  | { type: 'duck'; amount: number }
  | { type: 'muffle'; cutoffHz: number };

/**
 * A view onto a range of a source, placed at a position on the timeline.
 * Cutting splits clips; it never rewrites audio.
 */
export interface Clip {
  id: ClipId;
  sourceId: SourceId;
  /** Range within the source, in seconds. */
  sourceStart: number;
  sourceEnd: number;
  /** Where this clip begins on the project timeline, in seconds. */
  timelineStart: number;
  fadeIn: number;
  fadeOut: number;
  effects: Effect[];
}

export interface Track {
  id: TrackId;
  name: string;
  /** Linear gain, 1 = unity. */
  gain: number;
  /** -1 (left) .. 1 (right). */
  pan: number;
  muted: boolean;
  soloed: boolean;
  /** Ordered by timelineStart, non-overlapping. */
  clips: Clip[];
}

export interface Project {
  sources: Record<SourceId, AudioSource>;
  tracks: Track[];
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function emptyProject(): Project {
  return { sources: {}, tracks: [] };
}

export function clipDuration(clip: Clip): number {
  return clip.sourceEnd - clip.sourceStart;
}

export function clipEnd(clip: Clip): number {
  return clip.timelineStart + clipDuration(clip);
}

export function trackDuration(track: Track): number {
  return track.clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
}

export function projectDuration(project: Project): number {
  return project.tracks.reduce((max, t) => Math.max(max, trackDuration(t)), 0);
}

/** Tracks that should actually sound, honouring solo-overrides-mute semantics. */
export function audibleTracks(project: Project): Track[] {
  const anySolo = project.tracks.some((t) => t.soloed);
  return project.tracks.filter((t) => (anySolo ? t.soloed : !t.muted));
}

export function makeClip(
  sourceId: SourceId,
  sourceStart: number,
  sourceEnd: number,
  timelineStart: number,
): Clip {
  return {
    id: newId('clip'),
    sourceId,
    sourceStart,
    sourceEnd,
    timelineStart,
    fadeIn: 0,
    fadeOut: 0,
    effects: [],
  };
}

export function makeTrack(name: string, clips: Clip[] = []): Track {
  return {
    id: newId('track'),
    name,
    gain: 1,
    pan: 0,
    muted: false,
    soloed: false,
    clips,
  };
}

/** A track holding one whole source, placed at the start of the timeline. */
export function trackFromSource(source: AudioSource): Track {
  return makeTrack(source.name, [makeClip(source.id, 0, source.duration, 0)]);
}
