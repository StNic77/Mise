// Mise service worker
// Strategy: network-first for everything. This means the app always tries to
// fetch the latest version when online, only falling back to cache when
// offline. Updates show up the moment you reload while online — no manual
// version-bump ritual required (see README for the tradeoff this accepts).

const CACHE_NAME = 'mise-cache-v2'; // bump this string if you ever want to force a clean cache

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/api.js',
  './js/profiles.js',
  './js/recipes.js',
  './js/cycles.js',
  './js/menu.js',
  './js/mealslots.js',
  './js/checklist.js',
  './js/shoppinglist.js',
  './js/backup.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting(); // new SW takes over immediately, doesn't wait for tabs to close
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )
    ).then(() => self.clients.claim()) // take control of open tabs right away
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return; // never cache POSTs (e.g. Worker API calls)

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Got a fresh copy — update the cache for offline fallback next time.
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() =>
        // Offline (or network failed) — fall back to whatever's cached.
        caches.match(event.request).then((cached) => cached || caches.match('./index.html'))
      )
  );
});
