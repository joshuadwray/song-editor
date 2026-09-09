import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { APP_NAME, buildManifest } from './app.config';

/**
 * Serves the page title and web manifest from app.config.ts, so the app's
 * display name lives in exactly one place and cannot drift.
 */
function appIdentity(): Plugin {
  const manifest = () => JSON.stringify(buildManifest(), null, 2);
  const MANIFEST = 'manifest.webmanifest';

  return {
    name: 'app-identity',
    transformIndexHtml: (html) => html.replaceAll('%APP_NAME%', APP_NAME),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.split('?')[0].endsWith(MANIFEST)) return next();
        res.setHeader('Content-Type', 'application/manifest+json');
        res.end(manifest());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: MANIFEST, source: manifest() });
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
