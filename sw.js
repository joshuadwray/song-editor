/*
 * Service worker.
 *
 * Two jobs: make the app work with no network, and never surprise her with a
 * version change in the middle of an edit.
 *
 * The caching split is the important part, and it follows filenames:
 *
 *  - Files under assets/ are content-hashed by the build, so their names change
 *    whenever their contents do. They are immutable and safe to serve from
 *    cache first, forever.
 *  - Everything else — the manifest, the icons, the page itself — keeps a
 *    stable filename across deploys. Those must go to the network first, or a
 *    new icon or app name would never reach an installed copy. The cache stays
 *    as the offline fallback.
 *
 * Getting that backwards means the app silently pins itself to whatever it saw
 * the first time.
 */

const CACHE = 'song-editor-%CACHE_VERSION%';

/** Hashed build output, safe to treat as immutable. */
const IMMUTABLE = new URL('assets/', self.registration.scope).pathname;

// Deliberately no skipWaiting() here. A new worker waits until every tab has
// gone, or until the user accepts the update banner. Swapping the code under a
// session that is mid-edit is exactly the kind of surprise this app avoids.
self.addEventListener('install', () => {});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Each build gets its own cache name, so a deploy drops the last one
      // wholesale rather than leaving stale entries to be reasoned about.
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

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh.ok) (await caches.open(CACHE)).put(request, fresh.clone());
  return fresh;
}

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    if (fresh.ok) (await caches.open(CACHE)).put(request, fresh.clone());
    return fresh;
  } catch {
    return (
      (await caches.match(request)) ??
      (await caches.match(self.registration.scope)) ??
      Response.error()
    );
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    url.pathname.startsWith(IMMUTABLE) ? cacheFirst(request) : networkFirst(request),
  );
});
