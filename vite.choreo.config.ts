import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { APP_NAME, THEME_COLOR, buildManifest, cssVariables } from './choreo/app.config';

/**
 * The choreography app's build.
 *
 * Deliberately a separate build from Alainacity's (vite.config.ts) rather than
 * a second page in it: each app gets its own assets/ folder, manifest and
 * service worker, so a change here cannot alter a byte of what Alainacity
 * ships. Both deploy to the same site — this one into dist/choreo/.
 *
 *   npx vite build -c vite.choreo.config.ts --base=/song-editor/choreo/
 */

const ROOT = fileURLToPath(new URL('./choreo/', import.meta.url));

function appIdentity(): Plugin {
  const manifest = () => JSON.stringify(buildManifest(), null, 2);
  const MANIFEST = 'manifest.webmanifest';
  const cacheVersion = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

  return {
    name: 'choreo-identity',
    transformIndexHtml: (html) =>
      html
        .replaceAll('%APP_NAME%', APP_NAME)
        .replaceAll('%THEME_COLOR%', THEME_COLOR)
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
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: readFileSync(new URL('./choreo/sw.js', import.meta.url), 'utf8').replace(
          '%CACHE_VERSION%',
          cacheVersion,
        ),
      });
    },
  };
}

export default defineConfig({
  root: ROOT,
  plugins: [react(), appIdentity()],
  worker: { format: 'es' },
  build: {
    outDir: fileURLToPath(new URL('./dist/choreo/', import.meta.url)),
    emptyOutDir: true,
  },
  server: { port: 5174 },
});
