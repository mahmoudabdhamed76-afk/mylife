/* My Life — كاش أوفلاين
   HTML: الشبكة الأول (علشان التحديثات توصل فوراً) والكاش احتياطي
   الأصول الثابتة: الكاش الأول
   الـAPI: مايتكاشش خالص */
const CACHE = 'mylife-v8';
const ASSETS = ['mylife.html', 'manifest.webmanifest', 'icon.svg', 'icon-dark.svg', 'icon-light.svg', 'logo.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                        /* التزامن POST — سيبه يعدي */
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;            /* متكاششهاش */
  if (url.origin !== location.origin) return;

  const isDoc = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
  if (isDoc) {
    e.respondWith(
      fetch(req).then(res => {
        caches.open(CACHE).then(c => c.put('mylife.html', res.clone())).catch(() => {});
        return res;
      }).catch(() => caches.match('mylife.html'))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }))
  );
});
