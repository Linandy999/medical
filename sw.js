
var CACHE = 'medkb-2660a917b176';
var KEEP = /\/(app-[0-9a-f]+\.js|data-[0-9a-f]+\.json)$/;

self.addEventListener('install', function (e) {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.map(function (n) {
      // 舊版本的快取整個丟掉，免得裝置上堆好幾份 10 MB
      return (n !== CACHE && n.indexOf('medkb-') === 0) ? caches.delete(n) : null;
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== location.origin || !KEEP.test(url.pathname)) return;
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        // 存不進去（配額滿、隱私模式）不該讓頁面壞掉，照樣把回應給出去
        if (res && res.ok) { try { c.put(e.request, res.clone()); } catch (err) {} }
        return res;
      });
    });
  }));
});
