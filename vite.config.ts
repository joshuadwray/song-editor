import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  // The mp3 encoder is only imported from inside a worker, so Vite would not
  // discover it until the first export — and re-optimising mid-session forces
  // a full page reload. Pre-bundling it keeps that from happening.
  optimizeDeps: { include: ['@breezystack/lamejs'] },
  server: { port: 5173 },
});
