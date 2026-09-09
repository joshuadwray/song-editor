/*
 * Service worker.
 *
 * Two jobs: make the app work with no network, and never surprise her with a
 * version change in the middle of an edit.
 *
 * Navigations are network-first so an update is picked up as soon as one
 * exists, with the cache as the offline fallback. Build assets are hashed and
 * therefore immutable, so they are cache-first. That pairing also avoids the
 * classic mismatch where a stale index.html points at assets that no longer
 * exist: whichever copy of the HTML is served, its assets are alongside it.
 */

const CACHE = 'song-editor-v1';

// Deliberately no skipWaiting() here. A new worker waits until every tab has
// gone, or until the user accepts the update banner. Swapping the code under a
// session that is mid-edit is exactly the kind of surprise this app avoids.
self.addEventListener('install', () => {});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          await cache.put(request, fresh.clone());
          return fresh;
        } catch {
          return (
            (await caches.match(request)) ??
            (await caches.match(self.registration.scope)) ??
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const hit = await caches.match(request);
      if (hit) return hit;
      const fresh = await fetch(request);
      if (fresh.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(request, fresh.clone());
      }
      return fresh;
    })(),
  );
});
