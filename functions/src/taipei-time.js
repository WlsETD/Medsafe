// 台北時區的日期字串。
//
// 【為什麼不能直接用 toISOString().slice(0,10)】
// Cloud Functions 的執行環境時區是 UTC。用 UTC 算「今天」，在 UTC+8 會讓
// 早上 8 點以前的所有回報被記進前一天——於是病患早上吃了藥按下回報，
// 病歷上卻是昨天多了一筆、今天仍顯示未回報。
//
// js/db-service.js 的 adherence.dayKey() 已經因為同一個理由留下註解並避開
// toISOString()。伺服器端必須重現「同一套本地時區定義」，否則 LINE 寫進去的
// 那一天，和病患端網頁讀出來的那一天，會是不同的兩天。這是這次整合裡
// 最容易寫錯、且錯了之後最難從畫面上看出來的一件事。
//
// 用 Intl 而非手動加 8 小時：台灣目前不實施日光節約時間，但把時區規則
// 硬編碼成一個固定偏移量，是在對未來的法規變動下賭注。Intl 會跟著
// IANA 時區資料庫走。

const { TZ } = require('./config');

const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

// 回傳 'YYYY-MM-DD'（台北）。
// 刻意用 formatToParts 自行組裝，不依賴 format() 的語系輸出格式——
// 'en-CA' 目前產出 YYYY-MM-DD，但那是語系慣例，不是規格保證。
function dayKey(d) {
  const parts = DATE_FMT.formatToParts(d || new Date());
  const get = (t) => parts.find(p => p.type === t).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

module.exports = { dayKey };
