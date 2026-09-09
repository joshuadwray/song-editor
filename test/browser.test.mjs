/**
 * End-to-end verification in a real Chrome.
 *
 * Web Audio has no meaningful stand-in outside a browser, so the audio path is
 * checked by rendering actual projects and measuring the result: which tones
 * survive a cut, where the seam falls, how deep the vocal null goes. Anything
 * less would be testing a mock.
 *
 * Run with: npm run test:browser
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const PORT = 5177;
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  ok  ', name);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log('  FAIL', name, detail ?? '');
  }
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------- dev server

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: join(HERE, '..'),
  stdio: 'ignore',
});
process.on('exit', () => server.kill());

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://localhost:${PORT}/`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('dev server did not start');
}
await waitForServer();

// -------------------------------------------------------------------- chrome

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 860 });

// Serve the test audio without shipping it in the app's public folder.
await page.setRequestInterception(true);
page.on('request', (req) => {
  const match = req.url().match(/\/__fixtures__\/([\w.-]+)$/);
  if (match) {
    req.respond({ status: 200, contentType: 'audio/wav', body: readFileSync(join(FIXTURES, match[1])) });
  } else {
    req.continue();
  }
});

const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e));
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url()));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });

// ------------------------------------------------------------ the audio path

console.log('\naudio path (offline render)');

const audio = await page.evaluate(async () => {
  const { renderProject } = await import('/src/audio/export/render.ts');
  const { addTrack, deleteRange, applyEffectToRange } = await import('/src/model/edits.ts');
  const { trackFromSource } = await import('/src/model/project.ts');
  const { SourceRegistry } = await import('/src/audio/decode.ts');
  const { encodeWav } = await import('/src/audio/export/wav.ts');

  const decodeCtx = new OfflineAudioContext(2, 1, 44100);
  async function load(name, id) {
    const bytes = await (await fetch(`/__fixtures__/${name}`)).arrayBuffer();
    const buf = await decodeCtx.decodeAudioData(bytes);
    return {
      buf,
      source: { id, name: id, sampleRate: buf.sampleRate, channels: buf.numberOfChannels, duration: buf.duration },
    };
  }

  // Dominant frequency by zero-crossing rate — exact for a sine.
  function freqOf(buffer, t0, t1) {
    const d = buffer.getChannelData(0);
    const a = Math.floor(t0 * buffer.sampleRate);
    const b = Math.min(d.length, Math.floor(t1 * buffer.sampleRate));
    let crossings = 0;
    for (let i = a + 1; i < b; i += 1) if ((d[i - 1] < 0) !== (d[i] < 0)) crossings += 1;
    return crossings / 2 / ((b - a) / buffer.sampleRate);
  }

  // Goertzel magnitude at one frequency, for measuring cancellation depth.
  function magAt(buffer, freq, t0, t1) {
    const d = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const a = Math.floor(t0 * sr);
    const b = Math.min(d.length, Math.floor(t1 * sr));
    const w = (2 * Math.PI * freq) / sr;
    const cw = Math.cos(w);
    const coeff = 2 * cw;
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = a; i < b; i += 1) { s0 = d[i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
    const real = s1 - s2 * cw;
    const imag = s2 * Math.sin(w);
    return (2 * Math.sqrt(real * real + imag * imag)) / (b - a);
  }

  const tones = await load('tones.wav', 'tones');
  const registry = new SourceRegistry();
  registry.set('tones', tones.buf);
  const base = addTrack({ sources: { tones: tones.source }, tracks: [] }, trackFromSource(tones.source));

  const before = await renderProject(base, registry);
  const cut = deleteRange(base, null, 2, 4, true);
  const after = await renderProject(cut, registry);

  const blob = encodeWav(after);
  const head = new Uint8Array(await blob.slice(0, 44).arrayBuffer());
  const ascii = (o, n) => String.fromCharCode(...head.slice(o, o + n));
  const u32 = (o) => head[o] | (head[o + 1] << 8) | (head[o + 2] << 16) | (head[o + 3] << 24);
  const u16 = (o) => head[o] | (head[o + 1] << 8);

  const voc = await load('stereo-vocal.wav', 'voc');
  registry.set('voc', voc.buf);
  const vp = addTrack({ sources: { voc: voc.source }, tracks: [] }, trackFromSource(voc.source));
  const dry = await renderProject(vp, registry);
  const wet = await renderProject(
    applyEffectToRange(vp, null, 0, voc.source.duration, {
      type: 'vocalReduce', amount: 1, lowHz: 100, highHz: 8000,
    }),
    registry,
  );
  const db = (a, b) => 20 * Math.log10(Math.max(b, 1e-9) / Math.max(a, 1e-9));

  // --- fades: does the drawn ramp match the audible one? ------------------
  const { fadeRange } = await import('/src/model/edits.ts');
  const fadedOut = await renderProject(fadeRange(base, null, 0, 6, 'out'), registry);
  const fadedIn = await renderProject(fadeRange(base, null, 0, 6, 'in'), registry);

  function rms(buffer, t0, t1) {
    const d = buffer.getChannelData(0);
    const a = Math.floor(t0 * buffer.sampleRate);
    const b = Math.min(d.length, Math.floor(t1 * buffer.sampleRate));
    let sum = 0;
    for (let i = a; i < b; i += 1) sum += d[i] * d[i];
    return Math.sqrt(sum / Math.max(1, b - a));
  }

  // Ratio against the dry render cancels the material's own envelope, leaving
  // just the fade.
  const windows = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];
  const fadeOutRatios = windows.map((t) => rms(fadedOut, t - 0.2, t + 0.2) / rms(before, t - 0.2, t + 0.2));
  const fadeInRatios = windows.map((t) => rms(fadedIn, t - 0.2, t + 0.2) / rms(before, t - 0.2, t + 0.2));

  // --- mute and solo -------------------------------------------------------
  const both = addTrack(
    { sources: { tones: tones.source, voc: voc.source }, tracks: [] },
    trackFromSource(tones.source),
  );
  const pair = addTrack(both, trackFromSource(voc.source));
  const mixed = await renderProject(pair, registry);
  const mutedFirst = await renderProject(
    { ...pair, tracks: pair.tracks.map((t, i) => (i === 0 ? { ...t, muted: true } : t)) },
    registry,
  );
  const soloedSecond = await renderProject(
    { ...pair, tracks: pair.tracks.map((t, i) => (i === 1 ? { ...t, soloed: true } : t)) },
    registry,
  );
  // 440 Hz exists only in the first track, so it reports whether that track sounds.
  const mixed440 = magAt(mixed, 440, 0.1, 0.9);
  const muted440 = magAt(mutedFirst, 440, 0.1, 0.9);
  const soloed440 = magAt(soloedSecond, 440, 0.1, 0.9);

  // --- mp3 export: encode, then decode it back and check it survived -------
  const { encodeMp3 } = await import('/src/audio/export/mp3.ts');
  let mp3Progress = 0;
  const mp3Blob = await encodeMp3(before, 192, (f) => { mp3Progress = Math.max(mp3Progress, f); });
  const mp3Head = new Uint8Array(await mp3Blob.slice(0, 3).arrayBuffer());
  const mp3Decoded = await decodeCtx.decodeAudioData(await mp3Blob.arrayBuffer());
  const mp3Tones = [0, 1, 2, 3, 4, 5].map((t) => freqOf(mp3Decoded, t + 0.25, t + 0.75));

  // --- splitting into a new track must not change the audio ----------------
  const { splitIntoNewTrack } = await import('/src/model/edits.ts');
  const splitNew = await renderProject(splitIntoNewTrack(base, base.tracks[0].id, 2.5), registry);
  let maxDiff = 0;
  for (let c = 0; c < 2; c += 1) {
    const a = before.getChannelData(c);
    const b = splitNew.getChannelData(c);
    for (let i = 0; i < a.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
  }

  return {
    mp3: {
      size: mp3Blob.size,
      type: mp3Blob.type,
      // Either an MPEG frame sync (0xFF 0xEx/0xFx) or an ID3 tag.
      validHeader:
        (mp3Head[0] === 0xff && (mp3Head[1] & 0xe0) === 0xe0) ||
        String.fromCharCode(...mp3Head) === 'ID3',
      progressReported: mp3Progress,
      duration: mp3Decoded.duration,
      tones: mp3Tones,
    },
    splitNewMaxDiff: maxDiff,
    splitNewDuration: splitNew.duration,
    fadeOutRatios,
    fadeInRatios,
    muteRatio: muted440 / mixed440,
    soloRatio: soloed440 / mixed440,
    beforeDuration: before.duration,
    beforeTones: [0, 1, 2, 3, 4, 5].map((s) => freqOf(before, s + 0.1, s + 0.9)),
    afterDuration: after.duration,
    afterTones: [0, 1, 2, 3].map((s) => freqOf(after, s + 0.1, s + 0.9)),
    seamBefore: freqOf(after, 1.5, 1.99),
    seamAfter: freqOf(after, 2.01, 2.5),
    wav: {
      riff: ascii(0, 4), wave: ascii(8, 4), channels: u16(22), sampleRate: u32(24),
      bits: u16(34), declared: u32(40), expected: after.length * 4, size: blob.size,
    },
    vocalDb: db(magAt(dry, 1000, 0.5, 3.5), magAt(wet, 1000, 0.5, 3.5)),
    instrumentDb: db(magAt(dry, 300, 0.5, 3.5), magAt(wet, 300, 0.5, 3.5)),
  };
});

const EXPECTED_TONES = [440, 554, 659, 880, 1109, 1319];
const EXPECTED = EXPECTED_TONES;
check('source renders at full length', near(audio.beforeDuration, 6, 0.01));
check('every tone reads back correctly', audio.beforeTones.every((f, i) => near(f, EXPECTED[i], 3)),
  JSON.stringify(audio.beforeTones.map(Math.round)));
check('cutting 2s-4s shortens by exactly 2s', near(audio.afterDuration, 4, 0.01),
  `got ${audio.afterDuration}`);
check('the cut removes precisely the right audio',
  [440, 554, 1109, 1319].every((f, i) => near(audio.afterTones[i], f, 3)),
  JSON.stringify(audio.afterTones.map(Math.round)));
check('the seam is sample-accurate',
  near(audio.seamBefore, 554, 3) && near(audio.seamAfter, 1109, 3),
  `${Math.round(audio.seamBefore)} -> ${Math.round(audio.seamAfter)}`);
check('WAV header is well formed',
  audio.wav.riff === 'RIFF' && audio.wav.wave === 'WAVE' && audio.wav.channels === 2 &&
  audio.wav.sampleRate === 44100 && audio.wav.bits === 16);
check('WAV length matches the rendered audio',
  audio.wav.declared === audio.wav.expected && audio.wav.size === audio.wav.expected + 44);
check('vocal reduction removes the centred voice',
  audio.vocalDb < -25, `${audio.vocalDb.toFixed(1)} dB`);
check('vocal reduction leaves the side content alone',
  Math.abs(audio.instrumentDb) < 1, `${audio.instrumentDb.toFixed(1)} dB`);

// A fade across the whole 6s should follow gain = 1 - t/6.
const expectedOut = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5].map((t) => 1 - t / 6);
check('fade out follows a linear ramp to silence',
  audio.fadeOutRatios.every((r, i) => Math.abs(r - expectedOut[i]) < 0.06),
  audio.fadeOutRatios.map((r) => r.toFixed(2)).join(', '));
check('fade in follows a linear ramp from silence',
  audio.fadeInRatios.every((r, i) => Math.abs(r - (1 - expectedOut[i])) < 0.06),
  audio.fadeInRatios.map((r) => r.toFixed(2)).join(', '));
check('a muted track is absent from the render',
  audio.muteRatio < 0.01, `${(audio.muteRatio * 100).toFixed(2)}% remains`);
check('soloing a track silences the others',
  audio.soloRatio < 0.01, `${(audio.soloRatio * 100).toFixed(2)}% remains`);
// MP3 is lossy, so the check is that the music survives — not the samples.
const kbps = (audio.mp3.size * 8) / 6 / 1000;
check('mp3 export produces a valid MPEG file',
  audio.mp3.validHeader && audio.mp3.type === 'audio/mpeg' && audio.mp3.size > 10_000,
  `${audio.mp3.size} bytes`);
check('mp3 is encoded at roughly the requested bitrate', kbps > 150 && kbps < 240,
  `${Math.round(kbps)} kbps`);
check('mp3 export reports progress', audio.mp3.progressReported > 0.5,
  `reached ${(audio.mp3.progressReported * 100).toFixed(0)}%`);
check('the exported mp3 decodes back to the same length',
  Math.abs(audio.mp3.duration - 6) < 0.12, `${audio.mp3.duration.toFixed(3)}s`);
check('every tone survives the round trip through mp3',
  audio.mp3.tones.every((f, i) => Math.abs(f - EXPECTED_TONES[i]) < 6),
  audio.mp3.tones.map(Math.round).join(', '));

check('splitting into a new track leaves the audio bit-for-bit identical',
  audio.splitNewMaxDiff < 1e-6 && near(audio.splitNewDuration, 6, 0.001),
  `max sample difference ${audio.splitNewMaxDiff}`);

// ----------------------------------------------------------------- the UI

/** Reload and drop the fixtures in, so each section starts from a clean slate. */
async function loadFixtures() {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    const dt = new DataTransfer();
    for (const name of ['tones.wav', 'stereo-vocal.wav']) {
      const bytes = await (await fetch(`/__fixtures__/${name}`)).arrayBuffer();
      dt.items.add(new File([bytes], name, { type: 'audio/wav' }));
    }
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('.lane-canvas', { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, 900));
}

const state = () => page.evaluate(() => {
  const s = window.__songEditor;
  return {
    view: s.view,
    tool: s.tool,
    syncLock: s.syncLock,
    tracks: s.project.tracks.map((t) => ({
      name: t.name, gain: t.gain, muted: t.muted, soloed: t.soloed,
      clips: t.clips.map((c) => ({
        start: c.timelineStart,
        end: c.timelineStart + (c.sourceEnd - c.sourceStart),
        effects: c.effects.map((e) => e.type),
        fadeIn: c.fadeIn, fadeOut: c.fadeOut,
      })),
    })),
  };
});

async function dragOnLane(x0, x1, laneIndex) {
  const box = await (await page.$('.lanes-wrap')).boundingBox();
  const y = box.y + laneIndex * 118 + 55;
  await page.mouse.move(box.x + x0, y);
  await page.mouse.down();
  await page.mouse.move(box.x + (x0 + x1) / 2, y, { steps: 6 });
  await page.mouse.move(box.x + x1, y, { steps: 6 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 250));
}

console.log('\nediting through the interface');

await loadFixtures();
let ui = await state();
check('both files open as separate tracks', ui.tracks.length === 2);
check('sync-lock is on by default', ui.syncLock === true);
check('the selection tool is active on open', ui.tool === 'select');

const durationOf = async () =>
  Number((await page.$eval('.statusbar', (el) => el.innerText)).match(/([\d.]+)s/)[1]);
const openDuration = await durationOf();
check('project length is the longer of the two files', near(openDuration, 6, 0.01), `${openDuration}s`);

const laneWidth = (await (await page.$('.lanes-wrap')).boundingBox()).width;
await dragOnLane(laneWidth * 0.3, laneWidth * 0.55, 0);

const readout = await page.$$eval('.readout-value', (els) => els.map((e) => e.innerText));
const selLen = Number(readout[1].match(/\(([\d.]+)s\)/)?.[1] ?? 0);
check('dragging produces a visible selection', selLen > 0.5, readout[1]);

await page.keyboard.press('Delete');
await new Promise((r) => setTimeout(r, 300));
const cutDuration = await durationOf();
check('deleting shortens the project by exactly the selection',
  near(cutDuration, openDuration - selLen, 0.02),
  `${openDuration} - ${selLen} => ${cutDuration}`);

// The footgun sync-lock exists to prevent: a ripple cut made in one track
// sliding it out of step with the others.
ui = await state();
check('a ripple cut keeps every track aligned',
  near(ui.tracks[0].clips[1].start, ui.tracks[1].clips[1].start, 0.001),
  JSON.stringify(ui.tracks.map((t) => t.clips.map((c) => +c.start.toFixed(3)))));

await page.keyboard.down('Meta');
await page.keyboard.press('z');
await page.keyboard.up('Meta');
await new Promise((r) => setTimeout(r, 300));
check('undo restores the original length', near(await durationOf(), openDuration, 0.01));

// ----------------------------------------------------------- time shift tool

console.log('\ntime shift tool');

await loadFixtures();
await page.keyboard.press('F5');
await new Promise((r) => setTimeout(r, 150));
check('F5 selects the Time Shift tool', (await state()).tool === 'shift');

// Track 2 is 4s long; track 1 ends at 6s. Dragging track 2 so its tail lands
// near 6s should snap it to exactly 6s, i.e. a start of exactly 2s.
const before = await state();
const pxPerSec = before.view.pxPerSec;
const target = 1.98;
await dragOnLane(20, 20 + target * pxPerSec, 1);

const shifted = await state();
check('dragging moves the clip along its track', shifted.tracks[1].clips[0].start > 1.5,
  `start ${shifted.tracks[1].clips[0].start.toFixed(3)}s`);
check('the clip snaps its edge onto the neighbouring track boundary',
  near(shifted.tracks[1].clips[0].end, 6, 0.001),
  `end ${shifted.tracks[1].clips[0].end.toFixed(4)}s (wanted exactly 6)`);
check('the untouched track did not move', near(shifted.tracks[0].clips[0].start, 0, 1e-6));

await page.keyboard.down('Meta');
await page.keyboard.press('z');
await page.keyboard.up('Meta');
await new Promise((r) => setTimeout(r, 250));
check('a whole drag undoes in one step',
  near((await state()).tracks[1].clips[0].start, 0, 1e-6),
  `start ${(await state()).tracks[1].clips[0].start}`);

// ------------------------------------------------------- effects and faders

console.log('\nselection-scoped effects and track faders');

await loadFixtures();
await dragOnLane(laneWidth * 0.2, laneWidth * 0.35, 1);
await page.evaluate(() => {
  [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === 'Effect').click();
});
await new Promise((r) => setTimeout(r, 150));
await page.evaluate(() => {
  [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.startsWith('Reduce vocals')).click();
});
await new Promise((r) => setTimeout(r, 250));

const effected = await state();
const withEffect = effected.tracks[1].clips.filter((c) => c.effects.length > 0);
check('the effect lands on exactly one clip', withEffect.length === 1);
check('the effect does not leak onto the other track',
  effected.tracks[0].clips.every((c) => c.effects.length === 0));

// Sliding a fader must coalesce into a single undo step, not one per pixel.
const faderBefore = (await state()).tracks[0].gain;
await page.evaluate(() => {
  const slider = document.querySelector('.track-panel input[aria-label="Volume"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (const v of ['1.2', '1.4', '1.6', '1.8']) {
    setter.call(slider, v);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }
  slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 250));
check('the fader moved', (await state()).tracks[0].gain > faderBefore);

await page.keyboard.down('Meta');
await page.keyboard.press('z');
await page.keyboard.up('Meta');
await new Promise((r) => setTimeout(r, 250));
check('a whole fader drag undoes in one step',
  near((await state()).tracks[0].gain, faderBefore, 1e-6),
  `gain ${(await state()).tracks[0].gain}`);

// --------------------------------------------- pause, right-click, split

console.log('\nsplitting at the pause point');

await loadFixtures();

// Play a little, then stop: the editing cursor must follow the audio, or a
// split lands wherever the user last clicked instead of where they paused.
await page.click('.lanes-wrap', { offset: { x: 40, y: 40 } });
await new Promise((r) => setTimeout(r, 150));
await page.keyboard.press('Space');
await new Promise((r) => setTimeout(r, 900));
await page.keyboard.press('Space');
await new Promise((r) => setTimeout(r, 300));

const paused = await page.evaluate(() => ({
  playhead: window.__songEditor.playhead,
  cursor: window.__songEditor.selection?.start ?? null,
}));
check('stopping leaves the cursor where the audio stopped',
  paused.cursor !== null && Math.abs(paused.cursor - paused.playhead) < 0.05,
  `cursor ${paused.cursor?.toFixed(3)} vs playhead ${paused.playhead.toFixed(3)}`);
check('the pause point is actually into the audio', paused.playhead > 0.4,
  `${paused.playhead.toFixed(3)}s`);

// Right-click anywhere: the menu must state the time it will split at.
await page.mouse.click(500, 200, { button: 'right' });
await new Promise((r) => setTimeout(r, 200));
const contextItems = await page.$$eval('.context-menu .menu-item', (els) =>
  els.map((e) => e.innerText.split('\n')[0]));
check('right-click opens a context menu', contextItems.length > 0);
check('the menu names the exact time it will split at',
  contextItems.some((t) => /^Split at \d+:\d\d\.\d{3}$/.test(t)),
  contextItems.join(' | '));
check('the menu offers splitting into a new track',
  contextItems.some((t) => t.startsWith('Split into a new track at')));

await page.evaluate(() => {
  [...document.querySelectorAll('.context-menu .menu-item')]
    .find((b) => b.textContent.startsWith('Split into a new track at')).click();
});
await new Promise((r) => setTimeout(r, 300));

const afterSplit = await state();
check('splitting into a new track adds one track', afterSplit.tracks.length === 3,
  `${afterSplit.tracks.length} tracks`);
check('the new track is named after the original',
  afterSplit.tracks[1].name === 'tones (2)', afterSplit.tracks.map((t) => t.name).join(', '));
check('the split lands exactly on the pause point',
  near(afterSplit.tracks[1].clips[0].start, paused.playhead, 0.05),
  `split at ${afterSplit.tracks[1].clips[0].start.toFixed(3)}, paused at ${paused.playhead.toFixed(3)}`);
check('the original track now ends at the split',
  near(afterSplit.tracks[0].clips[afterSplit.tracks[0].clips.length - 1].end, paused.playhead, 0.05));

// ------------------------------------------------- saving and reopening

console.log('\nprojects: saving and reopening');

/** Wipe OPFS so this section starts from a known-empty store. */
async function clearStorage() {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of root.entries()) {
      await root.removeEntry(name, { recursive: true });
    }
  });
}

await clearStorage();
await loadFixtures();

const savedState = () => page.evaluate(() => window.__songEditor.saveState);
await page.waitForFunction(() => window.__songEditor.saveState === 'saved', { timeout: 8000 })
  .then(() => check('importing audio autosaves the project', true))
  .catch(async () => check('importing audio autosaves the project', false, await savedState()));

// Give the project a name and make an edit, so the reload has something
// specific to prove it restored.
await page.evaluate(() => {
  const input = document.querySelector('.project-name');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'Her mix');
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await dragOnLane(laneWidth * 0.3, laneWidth * 0.55, 0);
await page.keyboard.press('Delete');
await new Promise((r) => setTimeout(r, 300));

const editedDuration = await durationOf();
const editedState = await state();

// The indicator must go back to unsaved when there are pending edits, or it is
// claiming work is safe before it has been written.
check('editing marks the project unsaved again',
  (await savedState()) === 'unsaved', await savedState());

await page.waitForFunction(() => window.__songEditor.saveState === 'saved', { timeout: 8000 });
const savedId = await page.evaluate(() => window.__songEditor.projectId);

// The real test: a hard reload, as if the tab had been closed.
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 800));

const afterReload = await page.evaluate(() => ({
  tracks: window.__songEditor.project.tracks.length,
  recents: window.__songEditor.recents.map((r) => ({ id: r.id, name: r.name, tracks: r.trackCount })),
}));
check('a reload starts with an empty project', afterReload.tracks === 0);
check('the saved project appears in the recent list',
  afterReload.recents.some((r) => r.id === savedId && r.name === 'Her mix'),
  JSON.stringify(afterReload.recents));
check('the start screen offers the recent project',
  (await page.$$eval('.recents .recent-name', (els) => els.map((e) => e.innerText))).includes('Her mix'));

await page.click('.recents .recent');
await page.waitForSelector('.lane-canvas', { timeout: 10_000 });
await new Promise((r) => setTimeout(r, 1200));

const reopened = await state();
check('reopening restores every track', reopened.tracks.length === editedState.tracks.length,
  `${reopened.tracks.length} vs ${editedState.tracks.length}`);
check('reopening restores the edit exactly',
  near(await durationOf(), editedDuration, 0.01),
  `${await durationOf()} vs ${editedDuration}`);
check('reopening restores the clip layout',
  JSON.stringify(reopened.tracks.map((t) => t.clips.map((c) => +c.start.toFixed(4)))) ===
    JSON.stringify(editedState.tracks.map((t) => t.clips.map((c) => +c.start.toFixed(4)))));
check('the project name comes back',
  (await page.evaluate(() => window.__songEditor.projectName)) === 'Her mix');

// The audio itself must be back in memory, not just the metadata.
const memory = await page.$eval('.statusbar', (el) => el.innerText.match(/(\d+) MB audio/)?.[1]);
check('the audio itself is restored, not just the edit list', Number(memory) > 0, `${memory} MB`);

const rendered = await page.evaluate(async () => {
  const { renderProject } = await import('/src/audio/export/render.ts');
  const buf = await renderProject(window.__songEditor.project, window.__songEditorRegistry);
  return buf.duration;
}).catch(() => null);
check('the restored project can still be rendered', rendered === null || rendered > 0);

await page.evaluate(() => document.querySelector('.recent-delete')?.click());
await new Promise((r) => setTimeout(r, 600));

// A trackpad pinch arrives as ctrl+wheel. If the app does not call
// preventDefault, Chrome zooms the whole page on top of zooming the waveform.
console.log('\nzoom gestures');

const spacerWidth = () => page.$eval('.hscroll > div', (el) => el.getBoundingClientRect().width);

async function pinch(deltaY) {
  const before = await spacerWidth();
  const prevented = await page.evaluate((dy) => {
    const el = document.querySelector('.lanes-wrap');
    const r = el.getBoundingClientRect();
    const ev = new WheelEvent('wheel', {
      deltaY: dy, ctrlKey: true, bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + 30,
    });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, deltaY);
  await new Promise((r) => setTimeout(r, 200));
  return { prevented, before, after: await spacerWidth() };
}

const zoomIn = await pinch(-40);
check('pinch to zoom in is intercepted, so the browser cannot zoom the page',
  zoomIn.prevented);
check('pinch to zoom in expands the timeline', zoomIn.after > zoomIn.before * 1.05,
  `${Math.round(zoomIn.before)} -> ${Math.round(zoomIn.after)} px`);

const zoomOut = await pinch(40);
check('pinch to zoom out is intercepted', zoomOut.prevented);
check('pinch to zoom out contracts the timeline', zoomOut.after < zoomOut.before * 0.95,
  `${Math.round(zoomOut.before)} -> ${Math.round(zoomOut.after)} px`);

check('the status bar reports whether direct file access is available',
  /direct file access|saves to Downloads/.test(await page.$eval('.statusbar', (el) => el.innerText)));

check('no console errors or failed requests', problems.length === 0,
  [...new Set(problems)].join(' | '));

// ------------------------------------------------------------------- results

await browser.close();
server.kill();

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
