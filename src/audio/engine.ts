/**
 * Transport and playback scheduling.
 *
 * Clips are scheduled in a rolling look-ahead window rather than all at once,
 * so pressing play on a long project does not allocate hundreds of nodes. The
 * pattern is the standard "two clocks" one: a coarse setInterval decides *what*
 * to schedule, and the audio clock decides exactly *when* it sounds.
 */

import { Project, Track, clipEnd, projectDuration } from '../model/project';
import { SourceRegistry } from './decode';
import { scheduleClip } from './graph';

/** How often the scheduler wakes, and how far ahead it schedules. */
const TICK_MS = 50;
const LOOKAHEAD = 0.4;

export type TransportState = 'stopped' | 'playing';

/** Solo overrides mute: if anything is soloed, only soloed tracks sound. */
function effectiveGain(project: Project, track: Track): number {
  const anySolo = project.tracks.some((t) => t.soloed);
  const audible = anySolo ? track.soloed : !track.muted;
  return audible ? track.gain : 0;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: number | null = null;

  private sources: AudioBufferSourceNode[] = [];
  private trackNodes = new Map<string, { gain: GainNode; panner: StereoPannerNode }>();
  private scheduled = new Set<string>();

  private project: Project | null = null;
  private registry: SourceRegistry | null = null;

  /** Anchors mapping project time onto the audio clock. */
  private anchorCtx = 0;
  private anchorProject = 0;
  private scheduledUpTo = 0;
  private endAt = Infinity;

  private state: TransportState = 'stopped';
  private pausedAt = 0;

  onStateChange: ((state: TransportState) => void) | null = null;

  /**
   * Contexts must be created (and resumed) from a user gesture, so this is
   * called lazily rather than at startup.
   */
  context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  get transportState(): TransportState {
    return this.state;
  }

  /** Current playhead position in project time. */
  get currentTime(): number {
    if (this.state !== 'playing' || !this.ctx) return this.pausedAt;
    return this.anchorProject + (this.ctx.currentTime - this.anchorCtx);
  }

  play(project: Project, registry: SourceRegistry, from: number, until?: number): void {
    this.stop(from);
    const ctx = this.context();

    this.project = project;
    this.registry = registry;
    this.anchorCtx = ctx.currentTime + 0.05; // small cushion so the first clip is not late
    this.anchorProject = from;
    this.scheduledUpTo = from;
    this.endAt = until ?? projectDuration(project);
    this.scheduled.clear();

    if (this.endAt - from <= 0) return;

    // Build a chain for *every* track, including silent ones, so toggling mute
    // or solo mid-playback is a gain change rather than a graph rebuild — which
    // would mean a restart, and an audible gap.
    const master = this.master!;
    this.trackNodes.clear();
    for (const track of project.tracks) {
      const gain = ctx.createGain();
      gain.gain.value = effectiveGain(project, track);
      const panner = ctx.createStereoPanner();
      panner.pan.value = track.pan;
      gain.connect(panner).connect(master);
      this.trackNodes.set(track.id, { gain, panner });
    }

    this.setState('playing');
    this.tick();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  stop(position?: number): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        // Already finished; stopping twice is not an error worth surfacing.
      }
      src.disconnect();
    }
    this.sources = [];
    this.pausedAt = position ?? this.currentTime;
    this.scheduled.clear();
    this.trackNodes.clear();
    this.setState('stopped');
  }

  seek(time: number): void {
    if (this.state === 'playing' && this.project && this.registry) {
      this.play(this.project, this.registry, time, this.endAt);
    } else {
      this.pausedAt = time;
    }
  }

  /**
   * Push gain/pan/mute/solo changes onto a graph that is already sounding.
   *
   * Takes the whole project because solo is a global decision: soloing one
   * track silences the others, so every track's gain has to be reconsidered.
   */
  applyTrackParams(project: Project): void {
    if (!this.ctx) return;
    this.project = project;
    const now = this.ctx.currentTime;
    for (const track of project.tracks) {
      const nodes = this.trackNodes.get(track.id);
      if (!nodes) continue;
      // Ramp rather than jump, so moving a slider does not click.
      nodes.gain.gain.setTargetAtTime(effectiveGain(project, track), now, 0.015);
      nodes.panner.pan.setTargetAtTime(track.pan, now, 0.015);
    }
  }

  private setState(state: TransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }

  private tick(): void {
    if (!this.ctx || !this.project || !this.registry) return;

    const now = this.currentTime;
    if (now >= this.endAt) {
      this.stop(this.endAt);
      return;
    }

    const windowEnd = Math.min(now + LOOKAHEAD, this.endAt);
    if (windowEnd <= this.scheduledUpTo) return;

    for (const track of this.project.tracks) {
      const trackInput = this.trackNodes.get(track.id);
      if (!trackInput) continue;

      for (const clip of track.clips) {
        if (this.scheduled.has(clip.id)) continue;

        const end = clipEnd(clip);
        if (end <= this.anchorProject) continue; // entirely before the playhead

        // Where this clip first makes sound, given where playback started.
        const soundStart = Math.max(clip.timelineStart, this.anchorProject);
        if (soundStart >= windowEnd) continue; // not yet inside the window
        if (soundStart >= this.endAt) continue;

        const buffer = this.registry.get(clip.sourceId);
        if (!buffer) continue;

        const when = this.anchorCtx + (soundStart - this.anchorProject);
        const skipped = soundStart - clip.timelineStart;
        const node = scheduleClip(
          this.ctx,
          clip,
          buffer,
          trackInput.gain,
          Math.max(when, this.ctx.currentTime),
          skipped,
        );
        this.sources.push(node);
        this.scheduled.add(clip.id);
      }
    }

    this.scheduledUpTo = windowEnd;
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}
