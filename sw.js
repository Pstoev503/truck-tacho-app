// Офлайн режим (PWA).
// Първо се опитва да вземе новата версия от интернет и я записва в кеша.
// Само ако няма връзка, отваря запазеното копие. Така шофьорите винаги
// получават обновленията, а без обхват приложението пак работи.
const CACHE_NAME = 'tacho-pro-v5';
const urlsToCache = ['./', './index.html', './manifest.json', './engine/tacho-rules.js', './engine/activity-log.js', './engine/overspeed.js', './engine/route.js', './engine/sync.js', './boss.html', './vendor/leaflet-1.9.4/leaflet.js', './vendor/leaflet-1.9.4/leaflet.css'];

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
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // данните от сървъра (/api/) никога не се пазят в кеша — те са лични и стари след минута
  if (url.pathname.includes('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then(r => {
        if (r) return r;
        // само страница може да се замени с началната; скрипт — не (иначе модулите се чупят)
        if (event.request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      }))
  );
});
