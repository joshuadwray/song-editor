/**
 * The choreography app's production build, served the way GitHub Pages will:
 * Alainacity at /song-editor/, this app beside it at /song-editor/choreo/.
 *
 * Two apps on one origin share browser storage and cache storage, so beyond
 * the usual checks (manifest, worker scope, offline) this proves they cannot
 * damage each other: separate storage, separate caches, and a deploy of one
 * leaving the other's offline copy alone.
 *
 * Run with: npm run test:choreo:prod
 */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { APP_NAME, PALETTE, THEME_COLOR } from '../choreo/app.config.ts';
import { APP_NAME as EDITOR_NAME } from '../app.config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist');
const BASE = '/song-editor/';
const CHOREO = `${BASE}choreo/`;
const PORT = 5192;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildEditor() {
  execFileSync('npx', ['vite', 'build', `--base=${BASE}`], { cwd: ROOT, stdio: 'ignore' });
}
function buildChoreo() {
  execFileSync('npx', ['vite', 'build', '-c', 'vite.choreo.config.ts', `--base=${CHOREO}`], { cwd: ROOT, stdio: 'ignore' });
}

console.log('building both apps…');
// Alainacity first: its build empties dist/, this one only dist/choreo/.
buildEditor();
buildChoreo();

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

let offline = false;
const server = createServer((req, res) => {
  if (offline) { req.socket.destroy(); return; }
  const url = req.url.split('?')[0];
  if (!url.startsWith(BASE)) { res.writeHead(404); return res.end('not found'); }
  let rel = normalize(url.slice(BASE.length)).replace(/^(\.\.[/\\])+/, '');
  if (rel === '' || rel === '.' || rel.endsWith('/')) rel = join(rel, 'index.html');
  const file = join(DIST, rel);
  if (!existsSync(file)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
server.listen(PORT);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1366, height: 768 });
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e));
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });

const ORIGIN = `http://localhost:${PORT}`;

// ------------------------------------------------------------------- build

console.log('\nthe build');
check('the choreography app is built into its own folder', existsSync(join(DIST, 'choreo', 'index.html')));
check('Alainacity is still at the root of the site', existsSync(join(DIST, 'index.html')));
const choreoAssets = readdirSync(join(DIST, 'choreo', 'assets'));
// Same-named files in each folder are fine (both build Alainacity's peak
// worker); what matters is that this app only ever loads from its own folder.
const html = readFileSync(join(DIST, 'choreo', 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
check('the app loads only its own files, never Alainacity’s',
  refs.every((r) => r.startsWith(CHOREO) || r.startsWith('./')), refs.join(', '));
const choreoJs = choreoAssets.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(DIST, 'choreo', 'assets', f), 'utf8')).join('\n');
check('the development test seam is absent from the build', !choreoJs.includes('__choreo'));
check('the device check page ships with it', existsSync(join(DIST, 'choreo', 'probe', 'index.html')));

// --------------------------------------------------------------------- app

console.log('\nthe app at its subpath');
await page.goto(ORIGIN + CHOREO, { waitUntil: 'networkidle0' });
check('the app loads from /song-editor/choreo/', (await page.$('.start')) !== null);
check('the page title is the app name', (await page.title()) === APP_NAME, await page.title());

const manifest = await page.evaluate(async () => {
  const href = document.querySelector('link[rel=manifest]').getAttribute('href');
  const url = new URL(href, location.href).href;
  const json = await (await fetch(url)).json();
  const icons = await Promise.all(json.icons.map(async (i) => ({ src: i.src, ok: (await fetch(new URL(i.src, url))).ok })));
  return { url, json, icons, startUrl: new URL(json.start_url, url).pathname, scope: new URL(json.scope, url).pathname };
});
check('it has its own manifest', manifest.url.endsWith('/song-editor/choreo/manifest.webmanifest'), manifest.url);
check('its name is its own, not Alainacity’s', manifest.json.name === APP_NAME && APP_NAME !== EDITOR_NAME);
check('it installs as its own app, scoped to its folder', manifest.startUrl === CHOREO && manifest.scope === CHOREO,
  `${manifest.startUrl} ${manifest.scope}`);
check('it installs as a standalone window', manifest.json.display === 'standalone');
check('every icon loads', manifest.icons.every((i) => i.ok), JSON.stringify(manifest.icons));
check('a maskable icon is provided for the ChromeOS shelf', manifest.json.icons.some((i) => i.purpose === 'maskable'));
check('the theme colour comes from the palette', manifest.json.theme_color === THEME_COLOR);
const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
check('palette variables are injected', accent === PALETTE.accent, accent);
const css = await page.evaluate(async () => {
  const link = document.querySelector('link[rel=stylesheet]');
  return link ? (await fetch(link.href)).text() : '';
});
const strays = [...css.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0]);
check('no colour is hardcoded in the stylesheet', strays.length === 0, [...new Set(strays)].join(', '));

console.log('\nservice workers');
const reg = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.ready;
  return { scope: r.scope };
});
check('its service worker is scoped to its own folder', new URL(reg.scope).pathname === CHOREO, reg.scope);
await page.reload({ waitUntil: 'networkidle0' });
await sleep(500);
check('the worker controls the page after a reload', await page.evaluate(() => !!navigator.serviceWorker.controller));

// Visit Alainacity too, so both workers and both caches exist.
await page.goto(ORIGIN + BASE, { waitUntil: 'networkidle0' });
check('Alainacity still loads beside it', (await page.$('.menubar')) !== null);
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload({ waitUntil: 'networkidle0' });
await sleep(500);
const scopes = await page.evaluate(async () =>
  (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname).sort());
check('each app has its own worker', JSON.stringify(scopes) === JSON.stringify([BASE, CHOREO]), scopes.join(', '));
const cachesBefore = await page.evaluate(() => caches.keys());
check('each app has its own cache',
  cachesBefore.some((k) => k.startsWith('song-editor-')) && cachesBefore.some((k) => k.startsWith('choreo-')),
  cachesBefore.join(', '));

// A deploy of Alainacity: a new build with a new cache version, activated the
// way she would by accepting the update banner. Its clean-up must not touch
// the choreography app's cache.
console.log('\na deploy of one app leaves the other alone');
await sleep(1100); // cache versions are stamped to the second
buildEditor();
buildChoreo();
await page.goto(ORIGIN + BASE, { waitUntil: 'networkidle0' });
const activated = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  await r.update();
  for (let i = 0; i < 50 && !r.waiting; i += 1) await new Promise((res) => setTimeout(res, 100));
  if (!r.waiting) return false;
  const changed = new Promise((res) => navigator.serviceWorker.addEventListener('controllerchange', res, { once: true }));
  r.waiting.postMessage('SKIP_WAITING');
  await changed;
  return true;
});
check('Alainacity’s update activates', activated);
await sleep(500);
const cachesAfter = await page.evaluate(() => caches.keys());
const choreoCache = cachesBefore.find((k) => k.startsWith('choreo-'));
check('the choreography app’s offline cache survives Alainacity’s deploy', cachesAfter.includes(choreoCache),
  `before: ${cachesBefore.join(', ')} / after: ${cachesAfter.join(', ')}`);
check('Alainacity still drops its own old cache',
  cachesAfter.filter((k) => k.startsWith('song-editor-')).length === 1, cachesAfter.join(', '));

// ------------------------------------------------------------ her work offline

console.log('\na piece, offline');
await page.goto(ORIGIN + CHOREO, { waitUntil: 'networkidle0' });
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  for await (const [n] of root.entries()) if (n === 'choreo') await root.removeEntry(n, { recursive: true });
});
// Build a piece through the real UI, from a generated WAV.
await page.evaluate(async () => {
  const sr = 44100, secs = 12, n = sr * secs;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i += 1) {
    const t = (i % (sr / 2)) / sr; // a click every half second: 120 BPM
    v.setInt16(44 + i * 2, Math.round(20000 * Math.exp(-t * 60) * Math.sin(2 * Math.PI * 900 * t)), true);
  }
  const dt = new DataTransfer();
  dt.items.add(new File([buf], 'Offline test.wav', { type: 'audio/wav' }));
  document.querySelector('.start').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
await page.waitForSelector('.editor', { timeout: 20_000 });
await page.click('.note-cell textarea[data-ec="1"]');
await page.keyboard.type('Works with no wifi');
await page.waitForFunction(() => document.querySelector('.save-state')?.dataset.state === 'saved', { timeout: 8000 })
  .catch(() => {});

offline = true;
await page.setOfflineMode(true);
await page.goto(ORIGIN + CHOREO, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForSelector('.piece-open', { timeout: 10_000 }).catch(() => {});
check('with the network off, the app opens and lists her piece',
  (await page.$$eval('.piece-name', (els) => els.map((e) => e.innerText)).catch(() => [])).includes('Offline test'));
await page.click('.piece-open').catch(() => {});
const restored = await page.waitForFunction(
  () => document.querySelector('.note-cell textarea[data-ec="1"]')?.value === 'Works with no wifi',
  { timeout: 15_000 },
).then(() => true).catch(() => false);
check('…and opens it, notes and all', restored);
await page.setOfflineMode(false);
offline = false;

// Pieces live under their own storage directory, never in Alainacity's.
const dirs = await page.evaluate(async () => {
  const names = [];
  for await (const [n] of (await navigator.storage.getDirectory()).entries()) names.push(n);
  return names;
});
check('its storage is namespaced apart from Alainacity’s', dirs.includes('choreo') && !dirs.includes('pieces'), dirs.join(', '));

const real = problems.filter((p) => !/ERR_INTERNET_DISCONNECTED|net::ERR_|Failed to fetch/.test(p));
check('no console errors or failed requests', real.length === 0, [...new Set(real)].join(' | '));

await browser.close();
server.close();

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
