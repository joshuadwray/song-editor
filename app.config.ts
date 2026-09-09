/**
 * The app's identity — the name she actually sees.
 *
 * Deliberately separate from two other things it must never be coupled to:
 *
 *  - the repository name, which fixes the URL. Renaming the repo breaks the
 *    GitHub Pages URL and any installed shortcut, so it should stay put.
 *  - the storage key in storage/projects.ts, which must never change or every
 *    saved project is orphaned.
 *
 * This, by contrast, is free to change whenever. Edit it here and the page
 * title, the manifest and the in-app text all follow.
 */

import { BACKGROUND_COLOR, THEME_COLOR } // Explicit extension: the production test loads this module in Node, which
// resolves imports literally rather than the way a bundler does.
from './theme.config.ts';

export const APP_NAME = 'Alainacity';

export const APP_DESCRIPTION =
  'A simple audio editor for trimming, cutting and mixing songs.';


// Re-exported so callers have one import for the app's identity.
export { BACKGROUND_COLOR, THEME_COLOR };

/** Built here so the name can never drift out of sync with the page. */
export function buildManifest(): Record<string, unknown> {
  return {
    name: APP_NAME,
    short_name: APP_NAME,
    description: APP_DESCRIPTION,
    // Relative, so the app works from a project subpath such as /song-editor/.
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    orientation: 'any',
    icons: [
      { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: './icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
