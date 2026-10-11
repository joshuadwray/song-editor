/**
 * Song playback, with looping and an optional click on every count.
 *
 * The song is the master clock for everything — the count display now, and
 * the rehearsal videos in phase 2 — so this is the one place that turns the
 * audio clock into song time.
 *
 * Playback is a chain of "passes", each a stretch of the song scheduled to
 * start at an exact audio-clock time. Looping a block just means scheduling the
 * next pass to begin the instant the last one ends, which the audio clock does
 * sample-accurately; a setTimeout-driven loop would stutter at every repeat,
 * and she will be looping one 8-count for minutes at a time.
 */

import { beatsBetween, type GridSegment } from '../model/grid';

const TICK_MS = 25;
const LOOKAHEAD = 0.3;
/** Delay before the first sound, so the first pass is never scheduled in the past. */
const START_DELAY = 0.06;

interface Pass {
  /** Audio-clock time the pass begins. */
  at: number;
  from: number;
  to: number;
  source: AudioBufferSourceNode;
}

export interface LoopRange {
  start: number;
  end: number;
}

export class Player {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private passes: Pass[] = [];
  private timer: number | null = null;
  private clickNodes: { node: OscillatorNode; end: number }[] = [];
  /** Audio-clock time up to which clicks have been scheduled. */
  private clicksUntil = 0;
  private stoppedAt = 0;

  loop: LoopRange | null = null;
  clickOn = false;
  grid: GridSegment[] = [];
  onEnded: (() => void) | null = null;

  get playing(): boolean {
    return this.passes.length > 0;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  /** The context is created lazily, on the first play, which is a user gesture. */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  setBuffer(buffer: AudioBuffer | null): void {
    this.stop();
    this.buffer = buffer;
    this.stoppedAt = 0;
  }

  /** Current song time, read from the audio clock while playing. */
  get currentTime(): number {
    if (!this.ctx || this.passes.length === 0) return this.stoppedAt;
    const now = this.ctx.currentTime;
    for (let i = this.passes.length - 1; i >= 0; i -= 1) {
      const p = this.passes[i];
      if (now >= p.at) return Math.min(p.to, p.from + (now - p.at));
    }
    return this.passes[0].from;
  }

  play(from: number = this.stoppedAt): void {
    if (!this.buffer) return;
    this.stopSources();
    const ctx = this.ensureContext();
    void ctx.resume();

    let start = Math.max(0, Math.min(from, this.buffer.duration));
    // Pressing play in a loop that is outside the playhead starts at the loop.
    if (this.loop && (start < this.loop.start || start >= this.loop.end - 0.01)) start = this.loop.start;
    if (start >= this.buffer.duration - 0.01) start = 0;

    const at = ctx.currentTime + START_DELAY;
    this.schedulePass(at, start, this.loop ? this.loop.end : this.buffer.duration);
    this.clicksUntil = at;
    this.tick();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  pause(): void {
    this.stoppedAt = this.currentTime;
    this.stopSources();
  }

  stop(): void {
    this.stopSources();
  }

  seek(time: number): void {
    const wasPlaying = this.playing;
    this.stopSources();
    this.stoppedAt = Math.max(0, Math.min(time, this.duration));
    if (wasPlaying) this.play(this.stoppedAt);
  }

  /** Changing the loop mid-play restarts from where she is, so it applies at once. */
  setLoop(loop: LoopRange | null): void {
    this.loop = loop && loop.end - loop.start > 0.05 ? loop : null;
    if (this.playing) this.play(this.currentTime);
  }

  setClick(on: boolean): void {
    this.clickOn = on;
    if (!on) this.stopClicks();
    else if (this.ctx) this.clicksUntil = this.ctx.currentTime;
  }

  dispose(): void {
    this.stopSources();
    void this.ctx?.close();
    this.ctx = null;
  }

  // ---------------------------------------------------------------- internals

  private schedulePass(at: number, from: number, to: number): void {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.master!);
    source.start(at, from, to - from);
    this.passes.push({ at, from, to, source });
    // Only the last few passes matter for timekeeping.
    if (this.passes.length > 3) this.passes.shift();
  }

  private tick(): void {
    const ctx = this.ctx;
    if (!ctx || this.passes.length === 0) return;
    const now = ctx.currentTime;
    const horizon = now + LOOKAHEAD;
    const last = this.passes[this.passes.length - 1];
    const lastEnds = last.at + (last.to - last.from);

    if (this.loop && lastEnds < horizon) {
      this.schedulePass(lastEnds, this.loop.start, this.loop.end);
    } else if (!this.loop && now >= lastEnds) {
      this.stoppedAt = 0;
      this.stopSources();
      this.onEnded?.();
      return;
    }

    if (this.clickOn) this.scheduleClicks(horizon);
  }

  private scheduleClicks(horizon: number): void {
    const ctx = this.ctx!;
    for (const p of this.passes) {
      const passEnd = p.at + (p.to - p.from);
      const lo = Math.max(this.clicksUntil, p.at);
      const hi = Math.min(horizon, passEnd);
      if (lo >= hi) continue;
      for (const beat of beatsBetween(this.grid, p.from + (lo - p.at), p.from + (hi - p.at))) {
        this.click(p.at + (beat.time - p.from), beat.count === 1);
      }
    }
    this.clicksUntil = Math.max(this.clicksUntil, horizon);
    // Release finished nodes, so a long loop does not accumulate them.
    this.clickNodes = this.clickNodes.filter((c) => c.end > ctx.currentTime);
  }

  private click(at: number, accent: boolean): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1175;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(accent ? 0.5 : 0.3, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
    osc.connect(gain).connect(this.master!);
    osc.start(at);
    osc.stop(at + 0.06);
    this.clickNodes.push({ node: osc, end: at + 0.06 });
  }

  private stopClicks(): void {
    for (const c of this.clickNodes) {
      try { c.node.stop(); } catch { /* already stopped */ }
    }
    this.clickNodes = [];
  }

  private stopSources(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    for (const p of this.passes) {
      try { p.source.stop(); } catch { /* already stopped */ }
      p.source.disconnect();
    }
    this.passes = [];
    this.stopClicks();
  }
}
