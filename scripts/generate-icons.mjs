/**
 * Rasterise the icon sources in assets/ into the PNGs the manifest points at.
 *
 * The icons used to be produced by an ad-hoc script that was never committed,
 * so they could not be regenerated. Run this after changing either SVG:
 *
 *   npm run icons
 *
 * Chrome does the rendering, since it is already a dev dependency and it is the
 * same engine that will display the result.
 */

import { copyFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** [source SVG, output PNG, pixel size] */
const TARGETS = [
  ['assets/icon.svg', 'public/icons/icon-192.png', 192],
  ['assets/icon.svg', 'public/icons/icon-512.png', 512],
  ['assets/icon-maskable.svg', 'public/icons/icon-maskable-512.png', 512],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();

for (const [source, output, size] of TARGETS) {
  const svg = readFileSync(join(ROOT, source), 'utf8');
  await page.setViewport({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0">${svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`,
  );
  // No omitBackground: a maskable icon must be fully opaque.
  await page.screenshot({ path: join(ROOT, output) });
  console.log(`${output}  ${size}x${size}  from ${source}`);
}

// The browser tab uses the vector directly — it scales to any density, and
// keeping it the same file guarantees the tab and the shelf never disagree.
copyFileSync(join(ROOT, 'assets/icon.svg'), join(ROOT, 'public/icons/icon.svg'));
console.log('public/icons/icon.svg  (browser tab)');

await browser.close();
