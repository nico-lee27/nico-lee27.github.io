const CACHE = 'health-tracker-v13';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // 页面导航：缓存优先（秒开）+ 后台静默更新（下次打开即最新版）
  if (e.request.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then(cached => {
        // 后台尝试拉新，成功则更新缓存；失败不影响本次打开
        const network = fetch(e.request).then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put('./index.html', copy));
          }
          return res;
        }).catch(() => null);
        // 有缓存立即返回（不等网络）；无缓存才等网络结果
        return cached || network.then(res => res || Response.error());
      })
    );
    return;
  }

  // 其余资源：缓存优先
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
