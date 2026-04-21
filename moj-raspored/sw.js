// Moj raspored — service worker
// v2: network-first za app shell (HTML/CSS/JS) → uvijek svježa verzija nakon deploya,
// cache je samo offline fallback. Bump CACHE ime kad god mijenjaš strategiju.
const CACHE = 'mr-v5';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.host === 'api.github.com') return;
  if (e.request.method !== 'GET') return;

  // Network-first, cache fallback (applies to HTML/JS/CSS/shell)
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.ok && url.origin === location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
