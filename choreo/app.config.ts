/**
 * The choreography app's identity and palette — the only place either lives.
 *
 * Follows Alainacity's split (see ../app.config.ts): the display name here is
 * free to change, but it must never be coupled to the URL path (/choreo/) or to
 * the storage key in src/choreo/storage.ts, which are fixed for good.
 *
 * Dark by default, unlike Alainacity: this app is mostly for watching video,
 * and a dark surround makes video read better and keeps the studio screen
 * from glaring.
 */

export const APP_NAME = 'Choreo';

export const APP_DESCRIPTION =
  'Count out a song in 8-counts and build a dance on top of it: notes, sections and rehearsal video.';

export const PALETTE = {
  bg: '#16151a',
  panel: '#1f1e24',
  panelRaised: '#24232a',
  sunken: '#18171c',
  border: '#2e2c35',
  borderStrong: '#3a3843',
  text: '#eceaf0',
  textDim: '#a09cab',
  textFaint: '#6e6a7a',
  /** Count 1, the playhead's 8-count, primary buttons. */
  accent: '#f2a541',
  accentSoft: '#3b2c14',
  accentText: '#16151a',
  accentLight: '#ffd08a',
  /** Rehearsal video, from phase 2. */
  video: '#5cc8c2',
  videoSoft: '#1f3a39',
  danger: '#ff8a80',
  dangerBg: '#3a1c1f',
  ok: '#8fd18f',
  waveform: '#6e6a7a',
  waveformPlayed: '#b9b4c6',
  playhead: '#ff6b5e',
} as const;

/**
 * Section colours, by index. A piece stores the index, not the colour, so
 * changing these recolours every saved piece rather than stranding old ones.
 */
export const SECTION_COLORS = ['#7b6ff0', '#e0699a', '#4fb3d9', '#8fd18f', '#e8a35b', '#c58be6'] as const;

export const THEME_COLOR = PALETTE.panel;
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
