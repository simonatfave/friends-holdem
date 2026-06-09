// 최소 서비스워커 — 설치 가능(PWA) + 네트워크 우선(항상 최신)
const CACHE = 'dice-v1';
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  // socket.io 등 동적 요청은 항상 네트워크
  if (req.method !== 'GET' || req.url.includes('/socket.io/')) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
