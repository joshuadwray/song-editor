/**
 * Edit operations. All pure: they take a Project and return a new Project,
 * never mutating the input. That is what makes undo a matter of keeping old
 * references around rather than copying audio.
 *
 * No function in this file touches a sample.
 */

import {
  Clip,
  ClipId,
  Effect,
  Project,
  Track,
  TrackId,
  clipDuration,
  clipEnd,
  makeClip,
  newId,
} from './project';

/** Times are in seconds; comparisons below this are treated as equal. */
const EPS = 1e-6;

function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.timelineStart - b.timelineStart);
}

/** Drop clips that edits have collapsed to nothing, and keep ordering stable. */
function normalize(clips: Clip[]): Clip[] {
  return sortClips(clips.filter((c) => clipDuration(c) > EPS));
}

function mapTracks(
  project: Project,
  trackIds: TrackId[] | null,
  fn: (track: Track) => Track,
): Project {
  const targeted = trackIds === null ? null : new Set(trackIds);
  return {
    ...project,
    tracks: project.tracks.map((t) => (targeted === null || targeted.has(t.id) ? fn(t) : t)),
  };
}

/**
 * Split any clip that spans `time` into two abutting clips.
 *
 * This is the primitive the rest of the file is built on: every range
 * operation becomes "split at both edges, then act on whole clips".
 */
export function splitTrackAt(track: Track, time: number): Track {
  const out: Clip[] = [];
  for (const clip of track.clips) {
    const start = clip.timelineStart;
    const end = clipEnd(clip);
    if (time <= start + EPS || time >= end - EPS) {
      out.push(clip);
      continue;
    }
    const offset = time - start;
    // The fades belong to the outer edges: the left piece keeps the fade-in,
    // the right piece keeps the fade-out, and the new seam gets neither.
    out.push({
      ...clip,
      id: newId('clip'),
      sourceEnd: clip.sourceStart + offset,
      fadeOut: 0,
    });
    out.push({
      ...clip,
      id: newId('clip'),
      sourceStart: clip.sourceStart + offset,
      timelineStart: time,
      fadeIn: 0,
    });
  }
  return { ...track, clips: normalize(out) };
}

export function splitAt(project: Project, trackIds: TrackId[] | null, time: number): Project {
  return mapTracks(project, trackIds, (t) => splitTrackAt(t, time));
}

/** Clips lying wholly inside [start, end), as a timeline-relative copy. */
export function copyRange(
  project: Project,
  trackIds: TrackId[] | null,
  start: number,
  end: number,
): Clip[] {
  const targeted = trackIds === null ? null : new Set(trackIds);
  const clips: Clip[] = [];
  for (const track of project.tracks) {
    if (targeted !== null && !targeted.has(track.id)) continue;
    // Split into a throwaway copy so partially-covered clips are cut cleanly.
    const split = splitTrackAt(splitTrackAt(track, start), end);
    for (const clip of split.clips) {
      if (clip.timelineStart >= start - EPS && clipEnd(clip) <= end + EPS) {
        clips.push({ ...clip, id: newId('clip'), timelineStart: clip.timelineStart - start });
      }
    }
  }
  return clips;
}

/**
 * Remove [start, end).
 *
 * `ripple` is the difference between Audacity's Delete (closes the gap, moving
 * later audio earlier) and Silence (leaves a hole). Trimming the head or tail
 * of a file is just this with the range running to an edge.
 */
export function deleteRange(
  project: Project,
  trackIds: TrackId[] | null,
  start: number,
  end: number,
  ripple: boolean,
): Project {
  if (end - start <= EPS) return project;
  const span = end - start;

  return mapTracks(project, trackIds, (track) => {
    const split = splitTrackAt(splitTrackAt(track, start), end);
    const kept: Clip[] = [];
    for (const clip of split.clips) {
      const inside = clip.timelineStart >= start - EPS && clipEnd(clip) <= end + EPS;
      if (inside) continue;
      if (ripple && clip.timelineStart >= end - EPS) {
        kept.push({ ...clip, timelineStart: clip.timelineStart - span });
      } else {
        kept.push(clip);
      }
    }
    return { ...track, clips: normalize(kept) };
  });
}

/**
 * Keep only [start, end), discarding audio outside it and leaving what remains
 * where it sits. Audacity's "Trim Audio Outside Selection" (Ctrl+T).
 */
export function trimToRange(
  project: Project,
  trackIds: TrackId[] | null,
  start: number,
  end: number,
): Project {
  return mapTracks(project, trackIds, (track) => {
    const split = splitTrackAt(splitTrackAt(track, start), end);
    const kept = split.clips.filter(
      (c) => c.timelineStart >= start - EPS && clipEnd(c) <= end + EPS,
    );
    return { ...track, clips: normalize(kept) };
  });
}

/** Insert clips at `time`, pushing existing audio later to make room. */
export function insertClips(
  project: Project,
  trackId: TrackId,
  time: number,
  clips: Clip[],
): Project {
  if (clips.length === 0) return project;
  const span = Math.max(...clips.map(clipEnd));

  return mapTracks(project, [trackId], (track) => {
    const split = splitTrackAt(track, time);
    const shifted = split.clips.map((c) =>
      c.timelineStart >= time - EPS ? { ...c, timelineStart: c.timelineStart + span } : c,
    );
    const pasted = clips.map((c) => ({
      ...c,
      id: newId('clip'),
      timelineStart: c.timelineStart + time,
    }));
    return { ...track, clips: normalize([...shifted, ...pasted]) };
  });
}

/**
 * Apply `fn` to every clip inside [start, end), splitting at the edges first so
 * the change lands exactly on the selection. This is the shared path for fades
 * and for the selection-scoped effects (vocal reduction, silence, duck, muffle).
 */
export function mapRange(
  project: Project,
  trackIds: TrackId[] | null,
  start: number,
  end: number,
  fn: (clip: Clip) => Clip,
): Project {
  if (end - start <= EPS) return project;
  return mapTracks(project, trackIds, (track) => {
    const split = splitTrackAt(splitTrackAt(track, start), end);
    const clips = split.clips.map((c) =>
      c.timelineStart >= start - EPS && clipEnd(c) <= end + EPS ? fn(c) : c,
    );
    return { ...track, clips: normalize(clips) };
  });
}

export function applyEffectToRange(
  project: Project,
  trackIds: TrackId[] | null,
  start: number,
  end: number,
  effect: Effect,
): Project {
  return mapRange(project, trackIds, start, end, (clip) => ({
    ...clip,
    // One effect of a given type per clip; re-applying replaces its settings.
    effects: [...clip.effects.filter((e) => e.type !== effect.type), effect],
  }));
}

export function clearEffectsInRange(
  project: Project,
  trackIds: TrackId[] | null,
  start: number,
  end: number,
): Project {
  return mapRange(project, trackIds, start, end, (clip) => ({ ...clip, effects: [] }));
}

/**
 * Fade across the selection. Unlike an effect this is not per-clip decoration:
 * the ramp spans the whole range, so the first clip carries the fade-in and the
 * last carries the fade-out, matching what you hear in Audacity.
 */
export function fadeRange(
  project: Project,
  trackIds: TrackId[] | null,
  start: number,
  end: number,
  direction: 'in' | 'out',
): Project {
  const targeted = trackIds === null ? null : new Set(trackIds);
  return {
    ...project,
    tracks: project.tracks.map((track) => {
      if (targeted !== null && !targeted.has(track.id)) return track;
      const split = splitTrackAt(splitTrackAt(track, start), end);
      const inRange = split.clips.filter(
        (c) => c.timelineStart >= start - EPS && clipEnd(c) <= end + EPS,
      );
      if (inRange.length === 0) return track;

      const edge = direction === 'in' ? inRange[0] : inRange[inRange.length - 1];
      const clips = split.clips.map((c) =>
        c.id === edge.id
          ? direction === 'in'
            ? { ...c, fadeIn: clipDuration(c) }
            : { ...c, fadeOut: clipDuration(c) }
          : c,
      );
      return { ...track, clips: normalize(clips) };
    }),
  };
}

/**
 * Move one clip along its track (Audacity's Time Shift tool).
 *
 * Clamped to zero and to its neighbours: clips within a track are kept ordered
 * and non-overlapping, which the playback scheduler and every range operation
 * rely on.
 */
export function moveClip(
  project: Project,
  trackId: TrackId,
  clipId: ClipId,
  newStart: number,
): Project {
  return mapTracks(project, [trackId], (track) => {
    const ordered = sortClips(track.clips);
    const index = ordered.findIndex((c) => c.id === clipId);
    if (index === -1) return track;

    const clip = ordered[index];
    const prev = ordered[index - 1];
    const next = ordered[index + 1];
    const lowest = prev ? clipEnd(prev) : 0;
    const highest = next ? next.timelineStart - clipDuration(clip) : Infinity;

    const start = Math.min(Math.max(newStart, lowest), Math.max(lowest, highest));
    return {
      ...track,
      clips: ordered.map((c) => (c.id === clipId ? { ...c, timelineStart: start } : c)),
    };
  });
}

/**
 * Split a track at `time`, moving everything after the split into a new track
 * below it. Audacity calls this "Split New".
 *
 * The new track keeps its position on the timeline rather than sliding to zero,
 * so the project still sounds identical after the split — the audio has only
 * been re-housed, not moved.
 */
export function splitIntoNewTrack(
  project: Project,
  trackId: TrackId,
  time: number,
): Project {
  const index = project.tracks.findIndex((t) => t.id === trackId);
  if (index === -1) return project;

  const split = splitTrackAt(project.tracks[index], time);
  const stay = split.clips.filter((c) => c.timelineStart < time - EPS);
  const leave = split.clips.filter((c) => c.timelineStart >= time - EPS);
  // Nothing on one side of the cut means there is no split to make.
  if (stay.length === 0 || leave.length === 0) return project;

  const tracks = [...project.tracks];
  tracks[index] = { ...split, clips: stay };
  tracks.splice(index + 1, 0, {
    ...split,
    id: newId('track'),
    name: `${split.name} (2)`,
    clips: leave,
  });
  return { ...project, tracks };
}

/** The span a track occupies on the timeline, or null if it holds nothing. */
export function trackExtent(track: Track): { start: number; end: number } | null {
  if (track.clips.length === 0) return null;
  return {
    start: Math.min(...track.clips.map((c) => c.timelineStart)),
    end: Math.max(...track.clips.map(clipEnd)),
  };
}

/** Reorder a track within the stack. */
export function moveTrackTo(project: Project, trackId: TrackId, delta: number): Project {
  const index = project.tracks.findIndex((t) => t.id === trackId);
  if (index === -1) return project;
  const target = Math.min(Math.max(index + delta, 0), project.tracks.length - 1);
  if (target === index) return project;
  const tracks = [...project.tracks];
  const [moved] = tracks.splice(index, 1);
  tracks.splice(target, 0, moved);
  return { ...project, tracks };
}

/**
 * Times a dragged clip should snap to: the timeline start, the cursor, and the
 * edges of every other clip. Without this, aligning two tracks by eye leaves
 * millisecond offsets that are audible but invisible.
 */
export function snapCandidates(project: Project, exceptClipId: ClipId | null): number[] {
  const times = new Set<number>([0]);
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.id === exceptClipId) continue;
      times.add(clip.timelineStart);
      times.add(clipEnd(clip));
    }
  }
  return [...times].sort((a, b) => a - b);
}

/** Slide a whole track in time (Audacity's Time Shift tool). */
export function shiftTrack(project: Project, trackId: TrackId, delta: number): Project {
  return mapTracks(project, [trackId], (track) => {
    // Clamp so a track can never be dragged to a negative start time.
    const earliest = track.clips.reduce((min, c) => Math.min(min, c.timelineStart), Infinity);
    const applied = Number.isFinite(earliest) ? Math.max(delta, -earliest) : delta;
    return {
      ...track,
      clips: track.clips.map((c) => ({ ...c, timelineStart: c.timelineStart + applied })),
    };
  });
}

export function updateTrack(
  project: Project,
  trackId: TrackId,
  patch: Partial<Omit<Track, 'id' | 'clips'>>,
): Project {
  return mapTracks(project, [trackId], (t) => ({ ...t, ...patch }));
}

export function removeTrack(project: Project, trackId: TrackId): Project {
  const tracks = project.tracks.filter((t) => t.id !== trackId);
  // Drop sources nothing references any more so memory tracks the timeline.
  const used = new Set(tracks.flatMap((t) => t.clips.map((c) => c.sourceId)));
  const sources = Object.fromEntries(
    Object.entries(project.sources).filter(([id]) => used.has(id)),
  );
  return { sources, tracks };
}

export function addTrack(project: Project, track: Track): Project {
  return { ...project, tracks: [...project.tracks, track] };
}

export { makeClip };
