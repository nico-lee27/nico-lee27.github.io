/* 家庭账本 Service Worker：离线缓存壳 + 内置数据，账本数据本身走 GitHub API */
const CACHE = 'family-ledger-v3';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/xlsx.full.min.js',
];
/* 内置数据只在自带数据的部署里存在，缺失不算失败 */
const OPTIONAL = ['./data/records.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all([c.addAll(ASSETS), ...OPTIONAL.map(u => c.add(u).catch(() => { }))]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.includes('api.github.com') || url.hostname.includes('raw.githubusercontent.com')) return; // 动态数据不缓存

  /* 代码文件走「网络优先」：保证改完版本用户打开就是新的，断网才回落缓存 */
  if ((/\.(html|js|css|json)$/.test(url.pathname) || url.pathname.endsWith('/')) && !url.pathname.includes('/vendor/')) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request).then(h => h || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
