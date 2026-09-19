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
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

// 非機密：官方帳號的 Basic ID（@ 開頭），用來組「一鍵傳送綁定碼」的深層連結。
// 這是公開資訊（任何人都查得到官方帳號 ID），因此用 param 而非 secret。
// 未設定時綁定畫面會退回「請手動輸入綁定碼」，功能不會壞。
const LINE_BASIC_ID = defineString('LINE_BASIC_ID', { default: '' });

// 非機密：LIFF 用的 LINE Login channel ID。用來檢查 /oauth2/v2.1/verify
// 回應裡的 aud 是不是我們自己這個 channel 核發的 ID Token——channel ID
// 本身就像 OAuth client_id，公開在前端 liff.init() 呼叫裡，不是密鑰。
// 未設定時 lineExchangeToken 會直接拒絕（P2 功能關閉），不影響 P0/P1。
const LINE_LOGIN_CHANNEL_ID = defineString('LINE_LOGIN_CHANNEL_ID', { default: '' });

// 非機密：LIFF App ID，用來組 https://liff.line.me/{id} 這個深層連結，
// 讓 webhook 的選單按鈕可以直接開啟 LIFF（見 js/line-liff-config.js 的
// window.LIFF_ID，兩邊記的是同一個值，一份給前端 liff.init()，一份給
// 伺服器組連結，本身都是公開 ID，不是密鑰）。未設定時選單不顯示
// 「完整藥箱」按鈕，其餘功能不受影響。
const LIFF_ID = defineString('LIFF_ID', { default: '' });

// 非機密：家屬檢視專用的 LIFF App ID。刻意與 LIFF_ID 分開——家屬看到的
// 是唯讀摘要頁（family.html），不是病患自己的 patient.html，兩者是不同的
// LIFF App（見 js/liff-bridge.js 支援指定 LIFF ID 的說明），但可以共用同一個
// LINE Login channel，因此不需要新增 LINE_LOGIN_CHANNEL_ID。未設定時
// 核銷成功後的確認訊息會退回純文字說明，不含可點擊連結。
const FAMILY_LIFF_ID = defineString('FAMILY_LIFF_ID', { default: '' });

const REGION = 'asia-east1';

// 綁定碼有效期。夠長到讓長輩換手機操作，短到讓暴力猜測不可行。
const LINK_CODE_TTL_MS = 10 * 60 * 1000;

// 家屬邀請碼有效期，刻意比病患自己綁定用的 LINK_CODE_TTL_MS 寬鬆：
// 邀請家人通常需要實際把手機遞過去、對方再打開 LINE 操作，
// 10 分鐘對這個情境偏緊。字母表與長度不變，暴力猜測的可行性不受影響
// （見 ALPHABET/CODE_LEN 的說明——安全性來自碼的亂度，不是效期長短）。
const FAMILY_INVITE_TTL_MS = 30 * 60 * 1000;

// 家屬同意（family_consents）的有效期上限。跟保險端的 consents 同樣的
// 個資法理由：一份「永久有效」的授權形同未取得同意。家屬照護關係通常
// 是長期的，因此給比保險端典型的 90 天寬鬆許多的上限，到期後病患
// 重新邀請一次即可（見 firestore.rules 家屬檢視一節：沒有 regrant 分支，
// 重新授權一律走「再邀請一次」，才會留下新的 sourceCode 可供稽核）。
const FAMILY_CONSENT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

// 與 js/db-service.js 的 adherence.KEEP_DAYS 必須一致。
// 伺服器端若不做同樣的裁切，LINE 回報會讓 adherenceLog 無限成長，
// 最終撞上 Firestore 單文件 1MB 上限——屆時連開藥都會寫不進去。
const KEEP_DAYS = 30;

const TZ = 'Asia/Taipei';

module.exports = {
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  OPENAI_API_KEY,
  LINE_BASIC_ID,
  LINE_LOGIN_CHANNEL_ID,
  LIFF_ID,
  FAMILY_LIFF_ID,
  REGION,
  LINK_CODE_TTL_MS,
  FAMILY_INVITE_TTL_MS,
  FAMILY_CONSENT_TTL_MS,
  KEEP_DAYS,
  TZ
};
