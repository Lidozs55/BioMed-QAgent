/*
 * Minimal install-ability service worker for the BioMed QAgent PWA shell.
 *
 * This worker is intentionally a network pass-through: the app is always
 * served by a local Application Host (same origin), so caching would only
 * risk serving stale assets after an upgrade. It exists purely so browsers
 * treat the app as installable (standalone window + taskbar/dock icon).
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", () => {
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
