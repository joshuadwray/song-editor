/**
 * The app's palette — the single place any colour is defined.
 *
 * Colour previously lived in four places: the CSS `:root` block, the canvas
 * renderer (which cannot read CSS variables), the web manifest, and a hardcoded
 * hex in the favicon. Recolouring meant finding all four. Now everything
 * derives from here, so a retheme is an edit to this file alone.
 *
 * Two groups, because they have genuinely different jobs:
 *
 *  - CHROME is the window furniture: menus, toolbar, panels, buttons. This is
 *    the part that carries the app's personality, and it is purple.
 *  - CANVAS is the waveform, drawn by hand. It stays Audacity blue on purpose.
 *    It is the thing she looks at all day and her eye is trained on it; the
 *    theme should surround the audio, not repaint it.
 */

/** Window furniture. Exposed to CSS as custom properties — see cssVariables(). */
export const CHROME = {
  /** Menus, active tools, focus. White text sits on this, so it must stay dark. */
  accent: '#7b3fe4',
  /** Pressed states and the deep end of the icon's gradient. */
  accentDeep: '#5f27cc',
  /** Backing for the update banner. */
  accentSoft: '#f0e8fe',
  chrome: '#e2daf0',
  chromeLight: '#f2ecfb',
  chromeDark: '#cbbbe8',
  border: '#ae9ad4',
  text: '#2c1250',
  textDim: '#6b5590',
  danger: '#b02020',
  dangerBg: '#fde8e8',
  dangerText: '#6a1414',
  /** Text on an accent-filled surface. Warm white, not pure. */
  accentText: '#fff7f2',
  /** Secondary text on an accent-filled surface, e.g. a menu shortcut. */
  accentTextDim: '#d9c4fa',
  /** Raised surfaces: inputs, buttons, the clip body. */
  surface: '#fff7f2',
  /** The track whose panel currently has focus. */
  panelFocus: '#d6c2f5',
  /** The start screen behind the recent-projects list. */
  emptyBg: '#f6f1fb',
  disabled: '#a897c4',
  scrollThumb: '#a08cc4',
  scrollThumbHover: '#8570ac',
  /** The transport read-out, styled after a hardware display. */
  readoutBg: '#2c1250',
  readoutText: '#ffb27a',
  /** Play. Green regardless of theme — it means go. */
  play: '#1a7a1a',
} as const;

/**
 * The waveform display.
 *
 * `peak` and `rms` are deliberately unchanged from Audacity's blue. Everything
 * around them is tinted to sit with the purple chrome without competing.
 */
export const CANVAS = {
  trackBg: '#e7e0f2',
  trackBgSelected: '#d3c0f0',
  clipBg: '#fff7f2',
  clipBgSelected: '#eaddfb',
  peak: '#3232c8',
  rms: '#6f6fdc',
  centerLine: '#a294b8',
  clipBorder: '#9481b0',
  rulerBg: '#e0d8ee',
  rulerText: '#2c1250',
  rulerTick: '#7c6a9c',
  /** Red, and staying red: it must never be mistaken for part of the theme. */
  playhead: '#c81e1e',
  cursor: '#3d2960',
  /**
   * Peach — the icon's warm accent, and the complement to purple. An edited
   * region has to be the one thing on screen that cannot be mistaken for
   * chrome, and warm-on-cool does that better than another shade of violet.
   */
  effectTint: 'rgba(255, 178, 122, 0.32)',
  effectBar: '#c96a28',
  effectText: '#7a3a0f',
  snapGuide: '#e8791a',
} as const;

/** Shown in the ChromeOS window frame and the install prompt. */
export const THEME_COLOR = CHROME.accent;
export const BACKGROUND_COLOR = CHROME.chrome;

const KEBAB = /[A-Z]/g;

/** CHROME as CSS custom properties, injected into the page head at build time. */
export function cssVariables(): string {
  const lines = Object.entries(CHROME).map(
    ([name, value]) => `  --${name.replace(KEBAB, (c) => `-${c.toLowerCase()}`)}: ${value};`,
  );
  return `:root {\n${lines.join('\n')}\n}`;
}
