/**
 * Production build checks.
 *
 * These verify the things that only exist in a real build served from a real
 * subpath: the service worker, the manifest, offline capability, and that the
 * development-only test seam is gone. Run with: npm run test:prod
 */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist');
const BASE = '/song-editor/';
const PORT = 5191;
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

console.log('building…');
execFileSync('npx', ['vite', 'build', `--base=${BASE}`], { cwd: ROOT, stdio: 'ignore' });

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

// Serve the build the way GitHub Pages would: only under the project subpath.
const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (!url.startsWith(BASE)) {
    res.writeHead(404);
    return res.end('not found');
  }
  const rel = normalize(url.slice(BASE.length) || 'index.html').replace(/^(\.\.[/\\])+/, '');
  const file = join(DIST, rel);
  if (!existsSync(file)) {
    res.writeHead(404);
    return res.end('404');
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
server.listen(PORT);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e));
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });

const URL_BASE = `http://localhost:${PORT}${BASE}`;

console.log('\nproduction build at a subpath');
await page.goto(URL_BASE, { waitUntil: 'networkidle0' });
check('the app loads from a subpath', await page.$('.menubar') !== null);
check('no failed requests', problems.length === 0, [...new Set(problems)].join(' | '));

check('the development test seam is absent from the build',
  await page.evaluate(() => window.__songEditor === undefined));

console.log('\nmanifest');
const manifest = await page.evaluate(async () => {
  const href = document.querySelector('link[rel=manifest]')?.getAttribute('href');
  if (!href) return null;
  const url = new URL(href, location.href).href;
  const res = await fetch(url);
  const json = await res.json();
  // Icon paths are relative to the manifest, so resolve them the same way.
  const icons = await Promise.all(
    json.icons.map(async (i) => ({
      src: i.src,
      ok: (await fetch(new URL(i.src, url).href)).ok,
    })),
  );
  return { url, json, icons, startUrl: new URL(json.start_url, url).pathname };
});
check('a manifest is linked and parses', manifest !== null);
check('the manifest is served from the app subpath',
  manifest.url.endsWith('/song-editor/manifest.webmanifest'), manifest.url);
check('start_url resolves inside the subpath', manifest.startUrl === BASE, manifest.startUrl);
check('the app is installable as a standalone window', manifest.json.display === 'standalone');
check('every icon actually loads', manifest.icons.every((i) => i.ok),
  JSON.stringify(manifest.icons));
check('a maskable icon is provided for the ChromeOS shelf',
  manifest.json.icons.some((i) => i.purpose === 'maskable'));

console.log('\nservice worker');
const reg = await page.evaluate(async () => {
  const registration = await navigator.serviceWorker.ready;
  return { scope: registration.scope, active: !!registration.active };
});
check('a service worker is active', reg.active);
check('its scope is confined to this app, not the whole origin',
  new URL(reg.scope).pathname === BASE, reg.scope);

// Reload once so the worker caches the assets it now controls.
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 700));
check('the app still works once the worker controls the page',
  await page.evaluate(() => !!navigator.serviceWorker.controller));

// Build a project first, so the offline check proves her work is reachable
// without a network — not merely that the shell renders.
console.log('\nsaving a project');

await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
});

await page.evaluate(async () => {
  // A one-second tone, generated in the page so no network is involved.
  const sr = 44100, frames = sr;
  const buf = new ArrayBuffer(44 + frames * 4);
  const view = new DataView(buf);
  const ascii = (o, t) => { for (let i = 0; i < t.length; i++) view.setUint8(o + i, t.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + frames * 4, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, sr, true); view.setUint32(28, sr * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(18000 * Math.sin(2 * Math.PI * 440 * (i / sr)));
    view.setInt16(44 + i * 4, v, true);
    view.setInt16(46 + i * 4, v, true);
  }
  const dt = new DataTransfer();
  dt.items.add(new File([buf], 'tone.wav', { type: 'audio/wav' }));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
await page.waitForSelector('.lane-canvas', { timeout: 10_000 });

await page.evaluate(() => {
  const input = document.querySelector('.project-name');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Offline test');
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
// Match the whole word: "unsaved changes" contains "saved", and a substring
// test would pass the instant the edit was made rather than once it was written.
await page.waitForFunction(
  () =>
    [...document.querySelectorAll('.statusbar span')].some(
      (el) => el.textContent.trim() === 'saved',
    ),
  { timeout: 8000 },
);
check('a project saves in the production build', true);

console.log('\noffline');
await page.setOfflineMode(true);
await page.reload({ waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 1400));

check('the app loads with no network at all', (await page.$('.menubar')) !== null);
check('the interface is fully rendered offline',
  (await page.$$('.toolbar button')).length > 5);
check('project storage works offline',
  await page.evaluate(() => window.isSecureContext && typeof navigator.storage?.getDirectory === 'function'));

const offlineRecents = await page.$$eval('.recents .recent-name', (els) => els.map((e) => e.innerText));
check('her saved project is listed offline', offlineRecents.includes('Offline test'),
  JSON.stringify(offlineRecents));

await page.click('.recents .recent');
await page.waitForSelector('.lane-canvas', { timeout: 10_000 });
await new Promise((r) => setTimeout(r, 900));
const offlineStatus = await page.$eval('.statusbar', (el) => el.innerText.replace(/\n/g, ' | '));

// A drawn waveform is the real proof the audio came back out of storage and
// was decoded — the status line alone would pass on metadata alone.
const colours = await page.evaluate(() => {
  const canvas = document.querySelector('.lane-canvas');
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const seen = new Set();
  for (let i = 0; i < data.length; i += 4000) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
  return seen.size;
});
check('the project reopens offline with its audio decoded and drawn',
  colours > 2 && /0\.[1-9]|[1-9]\d* MB audio/.test(offlineStatus),
  `${colours} waveform colours — ${offlineStatus}`);

await page.setOfflineMode(false);

await browser.close();
server.close();

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
