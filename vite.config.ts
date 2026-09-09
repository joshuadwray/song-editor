import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { APP_NAME, buildManifest } from './app.config';
import { THEME_COLOR, cssVariables } from './theme.config';

/**
 * Serves the page title and web manifest from app.config.ts, so the app's
 * display name lives in exactly one place and cannot drift.
 */
function appIdentity(): Plugin {
  const manifest = () => JSON.stringify(buildManifest(), null, 2);
  const MANIFEST = 'manifest.webmanifest';
  // Stamped into the service worker so every deploy gets its own cache and the
  // previous one is dropped on activation, rather than lingering as stale
  // entries nobody can account for.
  const cacheVersion = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

  return {
    name: 'app-identity',
    transformIndexHtml: (html) =>
      html
        .replaceAll('%APP_NAME%', APP_NAME)
        .replaceAll('%THEME_COLOR%', THEME_COLOR)
        // Injected into the head so the variables are defined before the
        // stylesheet loads, avoiding a flash of unstyled chrome.
        .replace('%THEME_VARIABLES%', `<style>\n${cssVariables()}\n    </style>`),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.split('?')[0].endsWith(MANIFEST)) return next();
        res.setHeader('Content-Type', 'application/manifest+json');
        res.end(manifest());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: MANIFEST, source: manifest() });
      // Emitted rather than copied from public/, so the cache version can be
      // substituted at build time.
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: readFileSync('sw.js', 'utf8').replace('%CACHE_VERSION%', cacheVersion),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), appIdentity()],
  worker: { format: 'es' },
  // The mp3 encoder is only imported from inside a worker, so Vite would not
  // discover it until the first export — and re-optimising mid-session forces
  // a full page reload. Pre-bundling it keeps that from happening.
  optimizeDeps: { include: ['@breezystack/lamejs'] },
  server: { port: 5173 },
});
