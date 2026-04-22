const CACHE_NAME = "app-v1";

const urlsToCache = [
  "/",
  "/index.html",
  "/logo.png"
];

// cache khi load lần đầu
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache);
    })
  );
});

// load offline
self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});