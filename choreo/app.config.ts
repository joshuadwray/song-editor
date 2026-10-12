/**
 * The choreography app's identity and palette — the only place either lives.
 *
 * Follows Alainacity's split (see ../app.config.ts): the display name here is
 * free to change, but it must never be coupled to the URL path (/choreo/) or to
 * the storage key in src/choreo/storage.ts, which are fixed for good.
 *
 * The colours are Alainacity's, taken from its theme.config.ts rather than
 * copied, so the two apps look like a pair and a retheme of Alainacity carries
 * over here by itself. This file only decides which of its colours plays which
 * role in this app.
 */

// Explicit extension: the production test loads this module in Node, which
// resolves imports literally rather than the way a bundler does.
import { CANVAS, CHROME } from '../theme.config.ts';

export const APP_NAME = 'Choreo';

export const APP_DESCRIPTION =
  'Count out a song in 8-counts and build a dance on top of it: notes, sections and rehearsal video.';

export const PALETTE = {
  bg: CHROME.chrome,
  panel: CHROME.chromeLight,
  /** Buttons and text boxes. */
  surface: CHROME.surface,
  border: CHROME.chromeDark,
  borderStrong: CHROME.border,
  text: CHROME.text,
  textDim: CHROME.textDim,
  textFaint: CHROME.disabled,
  /** Count 1, the playhead's 8-count, primary buttons. */
  accent: CHROME.accent,
  accentDeep: CHROME.accentDeep,
  accentSoft: CHROME.accentSoft,
  accentText: CHROME.accentText,
  accentTextDim: CHROME.accentTextDim,
  /**
   * The big count display: Alainacity's hardware-style transport read-out,
   * dark plum with peach digits, legible from across the studio.
   */
  readoutBg: CHROME.readoutBg,
  readoutText: CHROME.readoutText,
  danger: CHROME.danger,
  dangerBg: CHROME.dangerBg,
  ok: CHROME.play,
  /** The waveform stays Audacity blue, as in Alainacity. */
  waveform: CANVAS.peak,
  waveformBg: CANVAS.trackBg,
  playhead: CANVAS.playhead,
} as const;

/**
 * Section colours, by index. A piece stores the index, not the colour, so
 * changing these recolours every saved piece rather than stranding old ones.
 * Pale, so the dark section name stays readable on every one of them.
 */
export const SECTION_COLORS = ['#c9b6f7', '#f6b3c8', '#a9d8f0', '#b9e4b0', '#ffcba4', '#e4c1f2'] as const;

/** Shown in the ChromeOS window frame and the install prompt — the same as Alainacity's. */
export const THEME_COLOR = PALETTE.accent;
export const BACKGROUND_COLOR = PALETTE.bg;

const KEBAB = /[A-Z]/g;

export function cssVariables(): string {
  const lines = Object.entries(PALETTE).map(
    ([name, value]) => `  --${name.replace(KEBAB, (c) => `-${c.toLowerCase()}`)}: ${value};`,
  );
  SECTION_COLORS.forEach((c, i) => lines.push(`  --section-${i}: ${c};`));
  return `:root {\n${lines.join('\n')}\n}`;
}

export function buildManifest(): Record<string, unknown> {
  return {
    name: APP_NAME,
    short_name: APP_NAME,
    description: APP_DESCRIPTION,
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    orientation: 'any',
    icons: [
      { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: './icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
