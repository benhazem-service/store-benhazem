const CACHE_NAME = 'pos-customer-v1';
const urlsToCache = [
  './index.html',
  './customer.js',
  './firebase-config.js',
  './manifest.json',
  './icon.ico'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        return response || fetch(event.request);
      })
  );
});
