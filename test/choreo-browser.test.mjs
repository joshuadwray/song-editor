/**
 * The choreography app, end to end in a real Chrome.
 *
 * Loads a generated dance track with a known tempo and first downbeat, then
 * works through the app the way she would: check the counts, write notes,
 * name sections, fix count 1, loop a block, close the tab, come back.
 *
 * Run with: npm run test:choreo:browser
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { CHOREO_SONG } from './fixtures/generate-choreo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SONG = join(HERE, 'fixtures', CHOREO_SONG.file);
const PORT = 5178;
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(SONG)) {
  console.log('generating fixtures…');
  execFileSync('node', [join(HERE, 'fixtures', 'generate-choreo.mjs')], { stdio: 'ignore' });
}

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- dev server

const server = spawn('npx', ['vite', '-c', 'vite.choreo.config.ts', '--port', String(PORT), '--strictPort'], {
  cwd: join(HERE, '..'),
  stdio: 'ignore',
});
process.on('exit', () => server.kill());

for (let i = 0; ; i += 1) {
  try {
    if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
  } catch {
    // not up yet
  }
  if (i > 100) throw new Error('dev server did not start');
  await sleep(150);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage();
// Her Chromebook's screen. The timeline must fit without the page scrolling.
await page.setViewport({ width: 1366, height: 768 });

await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url().endsWith('/__fixtures__/song.wav')) {
    req.respond({ status: 200, contentType: 'audio/wav', body: readFileSync(SONG) });
  } else {
    req.continue();
  }
});

const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e));
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url()));

const editor = () => page.evaluate(() => {
  const s = window.__choreo;
  return {
    grid: s.piece.grid, notes: s.piece.notes, sections: s.piece.sections, confirmed: s.piece.gridConfirmed,
    name: s.name, saveState: s.saveState, time: s.player.currentTime, playing: s.player.playing,
    selection: s.selection,
  };
});
const waitSaved = (label) => page.waitForFunction(() => window.__choreo?.saveState === 'saved', { timeout: 8000 })
  .then(() => true).catch(() => { check(label, false, 'never reached "saved"'); return false; });

/** Time range of an 8-count, from the app's own grid code. */
const ecRange = (ec) => page.evaluate(async (e) => {
  const { ecRange: range } = await import('/@fs' + window.__choreoRoot + '/src/choreo/model/grid.ts');
  return range(window.__choreo.piece.grid, e);
}, ec);

async function clearStorage() {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
  });
}

const ROOT = join(HERE, '..');
async function open() {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await page.evaluate((root) => { window.__choreoRoot = root; }, ROOT);
}

// --------------------------------------------------------------- new piece

console.log('\nstarting a piece');

await open();
await clearStorage();
await open();
check('the start screen offers a new piece', (await page.$('.start button.primary')) !== null);

await page.evaluate(async () => {
  const bytes = await (await fetch('/__fixtures__/song.wav')).arrayBuffer();
  const file = new File([bytes], 'Her Song.wav', { type: 'audio/wav' });
  const dt = new DataTransfer();
  dt.items.add(file);
  document.querySelector('.start').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
await page.waitForSelector('.editor', { timeout: 30_000 });
await sleep(400);

let st = await editor();
check('dropping a song opens it as a new piece named after the file', st.name === 'Her Song', st.name);
check(`the tempo is detected (${CHOREO_SONG.bpm} BPM)`, near(st.grid[0].bpm, CHOREO_SONG.bpm, 0.1), String(st.grid[0].bpm));
check('count 1 lands on the first downbeat, within 15 ms',
  near(st.grid[0].start, CHOREO_SONG.lead, 0.015), String(st.grid[0].start));
check('she is asked to check the counts', (await page.$('.check-banner')) !== null);
check('the click is on while the counts are unchecked',
  await page.$eval('button.toggle[title^="Click"]', (b) => b.getAttribute('aria-pressed') === 'true'));
check('a new piece is saved straight away', st.saveState === 'saved', st.saveState);

const layout = await page.evaluate(() => ({
  page: document.documentElement.scrollHeight,
  window: window.innerHeight,
  timelineBottom: document.querySelector('.timeline').getBoundingClientRect().bottom,
}));
check('everything fits a 1366×768 Chromebook screen without scrolling',
  layout.page <= layout.window && layout.timelineBottom <= layout.window,
  JSON.stringify(layout));

const columns = await page.$$eval('.ruler-cell', (els) => els.map((e) => e.innerText.split('\n')[0]));
check('the timeline starts with the intro before count 1, then 8-count 1',
  columns[0] === 'intro' && columns[1] === '1', columns.slice(0, 3).join(','));
// 45 s at 118 BPM from 1.0 s: (45 - 1) / (480/118) = 10.8 -> 8-counts 1..11.
check('every 8-count of the song has a column', columns.at(-1) === '11', columns.at(-1));

await page.click('.check-banner button.primary');
await sleep(100);
check('confirming the counts dismisses the check', (await page.$('.check-banner')) === null);
check('…and is remembered in the piece', (await editor()).confirmed === true);

// ---------------------------------------------------------------- playback

console.log('\nplayback and counts');

await page.keyboard.press('Space');
await sleep(1500);
st = await editor();
check('space starts playback', st.playing);
check('song time advances in real time', near(st.time, 1.5, 0.35), st.time.toFixed(2));
const shown = await page.evaluate(() => ({
  ec: document.querySelector('[data-testid=current-ec]').innerText,
  count: document.querySelector('.cd-count.now')?.innerText,
}));
const expectCount = Math.floor((st.time - CHOREO_SONG.lead) / (60 / CHOREO_SONG.bpm)) % 8 + 1;
check('the count display follows the music', shown.ec === '8-count 1' && Math.abs(Number(shown.count) - expectCount) <= 1,
  `${shown.ec} count ${shown.count}, expected about ${expectCount}`);
const playheadX = await page.$eval('.tl-playhead', (el) => new DOMMatrix(getComputedStyle(el).transform).m41);
check('the playhead moves across the timeline', playheadX > 0, String(playheadX));
await page.keyboard.press('Space');
await sleep(100);
check('space pauses', !(await editor()).playing);

await page.keyboard.press('ArrowRight');
await sleep(100);
st = await editor();
const ec2 = await ecRange(1);
check('→ jumps to the start of the next 8-count', near(st.time, ec2.start, 0.01), `${st.time} vs ${ec2.start}`);

// Loop 8-count 3 (index 2): play from it, let it run past its end, and it must come back round.
console.log('\nlooping a block');
await page.click('.ruler-cell[data-ec="2"]');
await sleep(100);
await page.keyboard.press('l');
const ec3 = await ecRange(2);
await page.keyboard.press('Space');
await sleep((ec3.end - ec3.start) * 1000 + 900);
st = await editor();
check('a looped block plays round again instead of running on',
  st.playing && st.time >= ec3.start - 0.01 && st.time < ec3.start + 1.5,
  `t=${st.time.toFixed(2)}, block ${ec3.start.toFixed(2)}–${ec3.end.toFixed(2)}`);
await page.keyboard.press('Space');
await page.keyboard.press('l');

// ------------------------------------------------------------------ notes

console.log('\nnotes and sections');

await page.click('.note-cell textarea[data-ec="2"]');
await page.keyboard.type('Chaîné, chaîné, fan kick');
await sleep(150);
st = await editor();
check('typing in the timeline writes the note for that 8-count', st.notes['2'] === 'Chaîné, chaîné, fan kick', JSON.stringify(st.notes));
check('the block panel shows the same note', await page.$eval('.bp-note textarea', (t) => t.value) === 'Chaîné, chaîné, fan kick');
check('the count display shows the note for the 8-count under the playhead',
  (await page.$eval('.cd-note', (el) => el.innerText)).includes('Chaîné'));
check('a note marks the piece unsaved at once', st.saveState === 'unsaved', st.saveState);

// Undo outside the text box removes the whole note in one step, not letter by letter.
await page.click('.count-display');
await page.keyboard.down(MOD_KEY);
await page.keyboard.press('z');
await page.keyboard.up(MOD_KEY);
await sleep(100);
check('undo removes a typed note as one step', (await editor()).notes['2'] === undefined, JSON.stringify((await editor()).notes));
await page.keyboard.down(MOD_KEY);
await page.keyboard.down('Shift');
await page.keyboard.press('z');
await page.keyboard.up('Shift');
await page.keyboard.up(MOD_KEY);
await sleep(100);
check('redo brings it back', (await editor()).notes['2'] === 'Chaîné, chaîné, fan kick');

// Select 8-counts 1–4 by dragging across their numbers, and name them.
const box = async (ec) => page.$eval(`.ruler-cell[data-ec="${ec}"]`, (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
const from = await box(0), to = await box(3);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 6 });
await page.mouse.up();
await sleep(100);
st = await editor();
check('dragging across the numbers selects a block', st.selection.lo === 0 && st.selection.hi === 3, JSON.stringify(st.selection));
check('the block panel names the selection', (await page.$eval('.bp-head h2', (h) => h.innerText)) === '8-counts 1–4');
await page.type('.name-section input', 'Opening');
await page.click('.name-section button[type=submit]');
await sleep(100);
st = await editor();
check('naming the block creates a section', st.sections.length === 1 && st.sections[0].name === 'Opening'
  && st.sections[0].startEc === 0 && st.sections[0].endEc === 3, JSON.stringify(st.sections));
check('the section is drawn over its 8-counts', (await page.$eval('.tl-section', (el) => el.innerText)) === 'Opening');
check('the count display shows the section', (await page.$eval('.cd-section', (el) => el.innerText)) === 'Opening');

// -------------------------------------------------------------- the grid

console.log('\nfixing the grid');

const before = (await editor()).grid[0];
// She hears count 1 of 8-count 3 a little later than the grid has it, and presses 1 right on it.
const target = ec3.start + 0.12;
await page.evaluate((t) => window.__choreo.seek(t), target);
await page.click('.count-display');
await page.keyboard.press('1');
await sleep(100);
st = await editor();
const fixed = await ecRange(2);
check('“count 1 here” moves count 1 onto the playhead', near(fixed.start, target, 0.002), `${fixed.start} vs ${target}`);
check('…without renumbering: it is still 8-count 3', (await page.$eval('[data-testid=current-ec]', (e) => e.innerText)) === '8-count 3');
check('…and her note stays on 8-count 3', st.notes['2'] === 'Chaîné, chaîné, fan kick');
check('the tempo is unchanged by re-phasing', st.grid[0].bpm === before.bpm);

await page.click('button[aria-label="Nudge later"]');
await sleep(50);
check('nudge moves the counts 10 ms', near((await editor()).grid[0].start, st.grid[0].start + 0.01, 1e-6));

await page.click('button[title="Count at double speed"]');
await sleep(50);
check('×2 doubles the tempo', near((await editor()).grid[0].bpm, before.bpm * 2, 1e-9));
await page.click('button[title="Count at half speed"]');
await sleep(50);
check('÷2 halves it back', near((await editor()).grid[0].bpm, before.bpm, 1e-9));

// Triple-click selects the field's text; a select-all chord is unreliable in headless Chrome.
await page.click('.bpm input', { clickCount: 3 });
await page.keyboard.type('120.5');
await page.keyboard.press('Enter');
await sleep(50);
check('typing a tempo sets it', (await editor()).grid[0].bpm === 120.5);
await page.click('.count-display');
await page.keyboard.down(MOD_KEY);
await page.keyboard.press('z');
await page.keyboard.up(MOD_KEY);
await sleep(50);
check('grid changes are undoable', near((await editor()).grid[0].bpm, before.bpm, 1e-9));

// A splice: a second tempo part from 8-count 6.
const ec6 = await ecRange(5);
await page.evaluate((t) => window.__choreo.seek(t), ec6.start + 1.0);
await page.click('.more > button');
await page.click('.more-menu button:nth-child(2)');
await sleep(50);
st = await editor();
check('a tempo change can start mid-song', st.grid.length === 2 && near(st.grid[1].start, ec6.start + 1.0, 1e-6));
check('the controls say which tempo part they act on', (await page.$eval('.seg-label', (e) => e.innerText)) === 'Tempo part 2/2');

// --------------------------------------------------------- save and reopen

console.log('\nsaving and reopening');

await page.click('.piece-title', { clickCount: 3 });
await page.keyboard.type('Spring showcase');
await waitSaved('edits are saved');
const savedState = await editor();

// Nothing should be written just by opening a piece, or the list would
// reorder itself every time she looked at something.
const stamp = () => page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const pieces = await (await root.getDirectoryHandle('choreo')).getDirectoryHandle('pieces');
  for await (const [, dir] of pieces.entries()) {
    const f = await (await dir.getFileHandle('piece.json')).getFile();
    return JSON.parse(await f.text()).updatedAt;
  }
});
const stampBefore = await stamp();

await open();
await sleep(300);
check('a reload shows the piece in the list',
  (await page.$$eval('.piece-name', (els) => els.map((e) => e.innerText))).includes('Spring showcase'));
check('the list summarises it', /118 BPM · 1 note/.test(await page.$eval('.piece-meta', (e) => e.innerText)),
  await page.$eval('.piece-meta', (e) => e.innerText));
await page.click('.piece-open');
await page.waitForSelector('.editor', { timeout: 20_000 });
await sleep(1200);
st = await editor();
check('reopening restores her notes', st.notes['2'] === 'Chaîné, chaîné, fan kick');
check('reopening restores sections', JSON.stringify(st.sections) === JSON.stringify(savedState.sections));
check('reopening restores the grid exactly', JSON.stringify(st.grid) === JSON.stringify(savedState.grid));
check('the counts stay confirmed', st.confirmed && (await page.$('.check-banner')) === null);
check('the song itself is restored', (await page.$$('.wave-cell canvas')).length > 5);
check('opening a piece does not rewrite it', (await stamp()) === stampBefore && st.saveState === 'saved',
  `${await stamp()} vs ${stampBefore}, ${st.saveState}`);

// Typing then immediately leaving must not lose the last words.
await page.click('.note-cell textarea[data-ec="4"]');
await page.keyboard.type('Pirouette, lunge');
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await sleep(600);
await open();
await page.click('.piece-open');
await page.waitForSelector('.editor', { timeout: 20_000 });
await sleep(300);
check('switching away saves at once, without waiting for the autosave delay',
  (await editor()).notes['4'] === 'Pirouette, lunge', JSON.stringify((await editor()).notes));

// And leaving the piece straight after typing must not lose it either.
await page.click('.note-cell textarea[data-ec="5"]');
await page.keyboard.type('Jazz square');
await page.click('.back');
await page.waitForSelector('.piece-open');
check('the piece list counts a note typed just before leaving',
  /3 notes/.test(await page.$eval('.piece-meta', (e) => e.innerText)), await page.$eval('.piece-meta', (e) => e.innerText));
await page.click('.piece-open');
await page.waitForSelector('.editor', { timeout: 20_000 });
await sleep(300);
check('a note typed just before leaving is kept', (await editor()).notes['5'] === 'Jazz square');

// --------------------------------------------------------------- deleting

console.log('\ndeleting');
await page.click('.back');
await page.waitForSelector('.piece-delete');
await page.click('.piece-delete');
check('deleting asks first', (await page.$('.confirm')) !== null);
await page.click('.confirm button:not(.danger)');
check('“keep” keeps it', (await page.$$('.piece-row')).length === 1);
await page.click('.piece-delete');
await page.click('.confirm button.danger');
await sleep(300);
check('delete removes the piece', (await page.$$('.piece-row')).length === 0);
const leftovers = await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const pieces = await (await root.getDirectoryHandle('choreo')).getDirectoryHandle('pieces');
  const names = [];
  for await (const [n] of pieces.entries()) names.push(n);
  return names;
});
check('…including its stored song', leftovers.length === 0, leftovers.join(','));

check('no console errors or failed requests', problems.length === 0, [...new Set(problems)].join(' | '));

await browser.close();
server.kill();

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
