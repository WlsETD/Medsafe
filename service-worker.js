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
// v5：Phase 4 處方安全閘門與稽核軌跡（新增 js/audit.js，dashboard/admin 接上稽核）
// v6：P1-6 病患同意機制（保險端改讀 patient_summaries，patient/insurance 頁面改版）
// v7：P1-4 醫病對話改由 Firestore 承載（js/chatStore.js 全檔改寫）
// v8：Phase 5 FHIR 連線層（新增 js/fhir-client.js，逾時中止與 Base URL 設定生效）
// v9：P0-7 藥品安全標示改由引擎即時計算（移除 mockData 中寫死的 status/color/icon）
// v10：P0-8 首頁摘要／AI 分析／回診日期改由實際資料計算
// v11：修正藥品安全標示在缺少 atc 欄位的正式資料上失效
// v12：Vue 改用生產版建置；核保端首屏數字改為實際計算
// v13：管理端 KPI 與核保端趨勢圖改為實算／誠實空狀態
// v14：修正初次進入醫師端時交互作用關係圖不顯示
// v15：醫師端 KPI 改為由實際指派病患計算
// v16：管理端顯示 ATC 碼，規則管理改讀引擎實際使用的規則
// v17：藥物目錄擴充為 26 種；新增 DDInter 藥物庫頁面
// v18：管理端 ATC 欄改顯示引擎實際使用的碼，並標示不會生效的規則
// v19：醫師端交互作用檢測改以病患實際用藥為輸入（原本讀寫死的情境藥單）
// v20：Phase 6 —— img alt、響應式斷點、清除最後一批寫死統計
// v21：DDInter 規則真正接上比對——修復前 236 條規則已產生並進版控，
//      但醫師端與病患端都沒有載入，只有管理後台拿來顯示統計數字
// v22：藥物目錄 26→60 種（全數對照 WHO 官方索引查證），DDInter 可用規則 236→1,565 條；
//      並更正 glipizide 誤收「瑪爾胰」（實為 glimepiride 商品名）的藥物身分錯誤
// v23：服藥回報改為逐日記錄。此版**必須**升號，不可省略——
//      patient.html 在 data() 就呼叫 DbService.adherence.dayKey()，
//      而 js/ 走 stale-while-revalidate：不升號的話，回訪使用者第一次載入
//      會拿到新的 HTML 配上舊的 db-service.js，adherence 為 undefined 而整頁崩潰。
//      升號會在 activate 時刪除舊快取，強制回網路取新檔。
//      （這正是上方註解所說「版本號退化為加速手段」的例外：
//        跨檔案的 API 變更仍然需要它。）
// v25：模板加上 drugLabel() 防禦——即使 D3 mutate 仍正確顯示藥名
// v26：LINE 整合。此版**必須**升號，理由與 v23 完全相同——
//      js/firebase-config.js 新增了 window.functions（Cloud Functions 的 asia-east1
//      連線），而 patient.html 的 LINE 綁定頁在按下按鈕時就會用到它。
//      js/ 走 stale-while-revalidate：不升號的話，回訪使用者會拿到新的 HTML
//      配上舊的 firebase-config.js，window.functions 為 null，
//      畫面上的症狀是「產生綁定碼失敗：未載入 Cloud Functions SDK」——
//      而網路分頁看起來一切正常，因為那支舊檔是 Service Worker 給的，不是伺服器。
const CACHE_VERSION = 'medsafe-static-v26';

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
  './js/ddinter-drugs.js',
  './js/ddi-rules-ddinter.js',
  './js/audit.js',
  './js/fhir-client.js',
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
