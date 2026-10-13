// Офлайн режим (PWA).
// Първо се опитва да вземе новата версия от интернет и я записва в кеша.
// Само ако няма връзка, отваря запазеното копие. Така шофьорите винаги
// получават обновленията, а без обхват приложението пак работи.
const CACHE_NAME = 'tacho-pro-v3';
const urlsToCache = ['./', './index.html', './manifest.json', './engine/tacho-rules.js', './engine/activity-log.js', './engine/overspeed.js'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then(r => r || caches.match('./index.html')))
  );
});
