// 共用設定：區域、密鑰、常數。
//
// 【區域為什麼一定是 asia-east1】
// Firestore 資料庫建在 asia-east1（台灣）。Firestore 觸發器（onDocumentUpdated）
// 必須與資料庫同區域，否則部署會直接失敗。既然觸發器被綁死，其餘 Function
// 一併放在同區可少一次跨區往返——對「按下開藥、手機當場響」這個展示情境，
// 每一次跨太平洋往返都是看得出來的延遲。
//
// 前端呼叫 callable 時也必須指定同一個區域（見 patient.html 的 firebase.functions('asia-east1')），
// 少了那個參數會打到 us-central1 而得到 404，且錯誤訊息不會告訴你是區域問題。

const { defineSecret, defineString } = require('firebase-functions/params');

// 機密：只存在於 Secret Manager，不進 git、不進前端。
const LINE_CHANNEL_SECRET = defineSecret('LINE_CHANNEL_SECRET');
const LINE_CHANNEL_ACCESS_TOKEN = defineSecret('LINE_CHANNEL_ACCESS_TOKEN');

// 非機密：官方帳號的 Basic ID（@ 開頭），用來組「一鍵傳送綁定碼」的深層連結。
// 這是公開資訊（任何人都查得到官方帳號 ID），因此用 param 而非 secret。
// 未設定時綁定畫面會退回「請手動輸入綁定碼」，功能不會壞。
const LINE_BASIC_ID = defineString('LINE_BASIC_ID', { default: '' });

const REGION = 'asia-east1';

// 綁定碼有效期。夠長到讓長輩換手機操作，短到讓暴力猜測不可行。
const LINK_CODE_TTL_MS = 10 * 60 * 1000;

// 與 js/db-service.js 的 adherence.KEEP_DAYS 必須一致。
// 伺服器端若不做同樣的裁切，LINE 回報會讓 adherenceLog 無限成長，
// 最終撞上 Firestore 單文件 1MB 上限——屆時連開藥都會寫不進去。
const KEEP_DAYS = 30;

const TZ = 'Asia/Taipei';

module.exports = {
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_BASIC_ID,
  REGION,
  LINK_CODE_TTL_MS,
  KEEP_DAYS,
  TZ
};
