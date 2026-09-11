// MedSafe Cloud Functions — LINE 整合。
//
// 【這是本專案第一個伺服器端元件，先讀這段】
//
// 在此之前，MedSafe 是純靜態前端 + Firestore，`firestore.rules` 是唯一真正的
// 存取控制邊界（見 CLAUDE.md）。加入 Cloud Functions 之後，多了一個
// 「用 Admin SDK、不受規則管轄」的執行環境，因此必須明確界定它做什麼：
//
//   1. 保管 LINE 的機密（Channel Secret / Access Token）。純靜態前端無法
//      保管密鑰——這正是先前把自架 FHIR 代理整個砍掉的同一條原則。
//      LINE 整合無法在不新增伺服器端的前提下完成。
//
//   2. Admin SDK 的使用範圍刻意收得很窄，只有四件事：
//      · 核銷綁定碼、寫入 line_bindings / line_users（前端不可自行宣稱綁定）
//      · 推播時讀取 patient_data 的 reminders 與 medications
//      · 從 LINE 的 postback 寫入 adherenceLog
//      · 由已驗證的 LINE ID Token 換發 Firebase Custom Token（P2）
//
//   3. 【最重要】凡是「把病歷讀出來顯示給人看」的路徑，一律不走 Admin SDK，
//      而是由 LIFF 換發 Custom Token 後用前端 SDK 讀取，讓 firestore.rules
//      照常生效。LINE 整合沒有在安全邊界上開任何一個洞——只是換一扇門進來。
//      這一點是刻意的設計取捨，不是還沒做完，請勿為了「比較快」而改成
//      用 Admin SDK 直接把資料撈出來丟進聊天室。
//
// 四個新集合（line_link_codes / line_bindings / line_users / line_push_log）
// 在 firestore.rules 中對所有前端一律關閉，唯一的寫入者就是這裡。

const admin = require('firebase-admin');
admin.initializeApp();

const { setGlobalOptions } = require('firebase-functions/v2');
const { REGION } = require('./src/config');

// 區域必須與 Firestore 資料庫一致（asia-east1），理由見 src/config.js
setGlobalOptions({ region: REGION, maxInstances: 10 });

// ── P0：綁定 ──────────────────────────────────────────────────────────
const callable = require('./src/callable');
exports.lineCreateLinkCode = callable.lineCreateLinkCode;
exports.lineUnbind = callable.lineUnbind;

const richmenu = require('./src/richmenu');
exports.lineSetupRichMenu = richmenu.lineSetupRichMenu;

const webhook = require('./src/webhook');
exports.lineWebhook = webhook.lineWebhook;

// ── P1：提醒與警示 ────────────────────────────────────────────────────
const reminder = require('./src/reminder');
exports.dailyReminderPush = reminder.dailyReminderPush;
exports.lineSendTestReminder = reminder.lineSendTestReminder;

const prescription = require('./src/prescription');
exports.onPrescriptionAdded = prescription.onPrescriptionAdded;

// ── P2：LIFF 身分橋接 ─────────────────────────────────────────────────
// LINE_LOGIN_CHANNEL_ID 用 defineString（非機密，比照 LINE_BASIC_ID），
// 預設空字串，未設定時 lineExchangeToken 會在呼叫當下自行拒絕
// （failed-precondition），因此可以隨時安全部署，不需要等設定完成。
const exchange = require('./src/exchange');
exports.lineExchangeToken = exchange.lineExchangeToken;
