// MedSafe PWA Service Worker
// 只快取「同源的靜態檔案」(HTML/JS/圖片/manifest)，
// 完全不攔截 Firebase Auth / Firestore / HAPI FHIR 等跨網域 API 呼叫，
// 避免影響即時用藥資料的正確性。

// 版本號：只要 PRECACHE_URLS 裡任何一個檔案的內容改變，這裡就必須跟著加一。
// activate 會刪除所有非當前版本的 cache，這是既有使用者拿到新版程式的唯一途徑——
// 忘記加版本號，等於該次修補（包含安全性修補）永遠送不出去。
// v2：Phase 1 帳號安全修補（js/auth.js 角色驗證改寫、js/db-service.js 本地頭像）
// v3：Phase 2 藥物身分基礎建設（新增 js/drug-catalog.js，js/mockData.js 改用 ATC 碼）
// v4：Phase 3 交互作用引擎（新增 js/ddi-engine.js，dashboard.html 改接 ATC 比對）
const CACHE_VERSION = 'medsafe-static-v4';

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
  './js/drug-catalog.js',
  './js/ddi-engine.js',
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

  // 其他同源靜態資源：stale-while-revalidate。
  //
  // 不可用純 cache-first。js/ 目錄裡放的是身分驗證與權限判斷邏輯，而 cache-first
  // 沒有失效期限——曾經載入過舊版的使用者會永遠停在舊版，安全修補只有在我們記得
  // 手動加 CACHE_VERSION 時才送得出去，漏一次就是無限期的漏洞暴露。
  //
  // 這裡改為「先回快取維持載入速度，同時在背景抓新版寫回」，最遲下一次載入即生效，
  // 版本號則退化為加速手段而非唯一防線。離線時背景抓取失敗，仍回快取。
  event.respondWith(
    caches.match(req).then((cached) => {
      const fromNetwork = fetch(req)
        .then((res) => {
          // 只快取成功的回應。原本未檢查狀態碼，一個 404 會被永久快取下來。
          if (res && res.ok) {
            const resClone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, resClone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fromNetwork;
    })
  );
});
