/**
 * Building the Web Audio node graph for a project.
 *
 * This module is shared by live playback (AudioContext) and by export
 * (OfflineAudioContext). That sharing is deliberate: it is the only way to
 * guarantee the exported file matches what she heard. Anything that changes
 * the sound must change it here, once.
 *
 * We do not write a mixer. Scheduling each clip as an AudioBufferSourceNode
 * hands sample-accurate timing and summing to the browser's audio thread,
 * where UI jank cannot cause dropouts.
 */

import { Clip, Effect, Track, clipDuration } from '../model/project';

/** Short ramp at the edges of an effected region, so the seam does not click. */
const SEAM_RAMP = 0.005;

export interface NodeChain {
  input: AudioNode;
  output: AudioNode;
}

/**
 * Audacity's "Vocal Reduction": vocals sit centred in a stereo mix, so the mid
 * channel M = (L+R)/2 is mostly vocal. Since L = M+S and R = M-S, removing a
 * fraction k of the centre is simply L' = L - k*M, R' = R - k*M.
 *
 * The subtraction is band-limited so bass and kick — which are also centred —
 * survive. Without that, full removal guts the low end of the whole mix.
 *
 * Built from native nodes only, so it runs on the audio thread with no custom DSP.
 */
function vocalReduceChain(ctx: BaseAudioContext, effect: Extract<Effect, { type: 'vocalReduce' }>): NodeChain {
  const input = ctx.createGain();
  const output = ctx.createGain();

  const splitter = ctx.createChannelSplitter(2);
  input.connect(splitter);

  // Summing both channels into one gain node at 0.5 each produces mono M.
  const mid = ctx.createGain();
  mid.gain.value = 0.5;
  splitter.connect(mid, 0);
  splitter.connect(mid, 1);

  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = effect.lowHz;

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = effect.highHz;

  // Negated so that summing it at the output performs the subtraction.
  const invert = ctx.createGain();
  invert.gain.value = -effect.amount;

  mid.connect(highpass).connect(lowpass).connect(invert);

  // The output sums the untouched stereo signal with the negated mono band.
  // A mono input up-mixes to both channels under the default 'speakers'
  // interpretation, which is exactly the L-k*M / R-k*M we want.
  input.connect(output);
  invert.connect(output);

  return { input, output };
}

function effectChain(ctx: BaseAudioContext, effect: Effect): NodeChain {
  switch (effect.type) {
    case 'vocalReduce':
      return vocalReduceChain(ctx, effect);
    case 'silence': {
      const g = ctx.createGain();
      g.gain.value = 0;
      return { input: g, output: g };
    }
    case 'duck': {
      const g = ctx.createGain();
      g.gain.value = Math.max(0, 1 - effect.amount);
      return { input: g, output: g };
    }
    case 'muffle': {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = effect.cutoffHz;
      return { input: f, output: f };
    }
  }
}

function buildEffects(ctx: BaseAudioContext, effects: Effect[]): NodeChain | null {
  if (effects.length === 0) return null;
  const chains = effects.map((e) => effectChain(ctx, e));
  for (let i = 0; i < chains.length - 1; i += 1) {
    chains[i].output.connect(chains[i + 1].input);
  }
  return { input: chains[0].input, output: chains[chains.length - 1].output };
}

/** Per-track gain, pan and mute. Solo is resolved earlier, by audibleTracks(). */
export function buildTrackChain(ctx: BaseAudioContext, track: Track, destination: AudioNode): AudioNode {
  const gain = ctx.createGain();
  gain.gain.value = track.muted ? 0 : track.gain;
  const panner = ctx.createStereoPanner();
  panner.pan.value = track.pan;
  gain.connect(panner).connect(destination);
  return gain;
}

/**
 * Write the clip's volume envelope onto `gain`.
 *
 * `skipped` is how far into the clip playback begins — non-zero when the user
 * hits play in the middle of a clip, which must not restart its fade.
 */
function applyEnvelope(
  gain: GainNode,
  clip: Clip,
  when: number,
  skipped: number,
  hasEffects: boolean,
): void {
  const dur = clipDuration(clip);
  // An effected region gets a tiny ramp so the discontinuity at its edge is
  // inaudible; an explicit fade already covers that, so don't double up.
  const fadeIn = clip.fadeIn > 0 ? clip.fadeIn : hasEffects ? Math.min(SEAM_RAMP, dur / 2) : 0;
  const fadeOut = clip.fadeOut > 0 ? clip.fadeOut : hasEffects ? Math.min(SEAM_RAMP, dur / 2) : 0;

  // Where the clip would have started, even if that is before `when`.
  const clipStart = when - skipped;
  const clipEndTime = clipStart + dur;
  const p = gain.gain;

  if (fadeIn > 0 && skipped < fadeIn) {
    p.setValueAtTime(skipped / fadeIn, when);
    p.linearRampToValueAtTime(1, clipStart + fadeIn);
  } else {
    p.setValueAtTime(1, when);
  }

  if (fadeOut > 0) {
    const foStart = clipEndTime - fadeOut;
    if (when >= foStart) {
      // Playback began inside the fade-out; pick up at the right level.
      p.setValueAtTime(Math.max(0, 1 - (when - foStart) / fadeOut), when);
    } else {
      p.setValueAtTime(1, foStart);
    }
    p.linearRampToValueAtTime(0, clipEndTime);
  }
}

/**
 * Schedule one clip.
 *
 * @param when     context time at which sound should begin
 * @param skipped  seconds into the clip that playback starts at
 * @returns the source node, so a caller can stop it early
 */
export function scheduleClip(
  ctx: BaseAudioContext,
  clip: Clip,
  buffer: AudioBuffer,
  trackInput: AudioNode,
  when: number,
  skipped: number,
): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const gain = ctx.createGain();
  const effects = buildEffects(ctx, clip.effects);
  if (effects) {
    src.connect(gain).connect(effects.input);
    effects.output.connect(trackInput);
  } else {
    src.connect(gain).connect(trackInput);
  }

  applyEnvelope(gain, clip, when, skipped, clip.effects.length > 0);

  const remaining = clipDuration(clip) - skipped;
  src.start(when, clip.sourceStart + skipped, remaining);
  return src;
}
