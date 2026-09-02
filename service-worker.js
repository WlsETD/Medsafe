// MedSafe PWA Service Worker
// 只快取「同源的靜態檔案」(HTML/JS/圖片/manifest)，
// 完全不攔截 Firebase Auth / Firestore / HAPI FHIR 等跨網域 API 呼叫，
// 避免影響即時用藥資料的正確性。

const CACHE_VERSION = 'medsafe-static-v1';

const PRECACHE_URLS = [
  './index.html',
  './login.html',
  './dashboard.html',
  './patient.html',
  './admin.html',
  './insurance.html',
  './detail.html',
  './manifest.json',
  './images/LOGO.png',
  './js/auth.js',
  './js/chatStore.js',
  './js/db-service.js',
  './js/firebase-config.js',
  './js/mockData.js',
  './js/notify.js',
  './js/utils.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只處理 GET，且只處理同源請求；其餘（含所有跨網域 API）一律放行不快取。
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  // HTML 頁面：network-first，確保拿到最新版本，離線時退回快取。
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, resClone));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // 其他同源靜態資源：cache-first，加速載入。
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, resClone));
        return res;
      });
    })
  );
});
