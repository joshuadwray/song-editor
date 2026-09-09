/**
 * Service worker registration.
 *
 * Scoped to the app's own base path. On GitHub Pages every app under
 * `<user>.github.io` shares an origin, so a worker registered at the root would
 * intercept requests for the neighbouring app too.
 */

let waiting: ServiceWorker | null = null;

export function registerServiceWorker(onUpdateReady: () => void): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  const base = import.meta.env.BASE_URL;
  void navigator.serviceWorker
    .register(`${base}sw.js`, { scope: base })
    .then((registration) => {
      if (registration.waiting) {
        waiting = registration.waiting;
        onUpdateReady();
      }
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // A worker reaching "installed" while another already controls the
          // page means this is an update rather than a first install.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            waiting = installing;
            onUpdateReady();
          }
        });
      });
    })
    .catch(() => {
      // Offline support is a bonus; failing to register must never block the app.
    });
}

/** Activate a waiting update and reload, at a moment the user chose. */
export function applyUpdate(): void {
  if (!waiting) {
    window.location.reload();
    return;
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), {
    once: true,
  });
  waiting.postMessage('SKIP_WAITING');
}
