// 病患端網頁呼叫的 callable functions：產生綁定碼、解除綁定。
//
// 身分一律由 request.auth 取得，再回 Firestore 查 user_roles/{uid}。
// 前端傳來的任何 username / uid 都不採信——這正是原設計（讓前端自己寫
// line_link_codes）會造成帳號接管的地方，理由詳見 bindings.js 的長註解。

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');

const { REGION, LINE_BASIC_ID, LINK_CODE_TTL_MS } = require('./config');
const bindings = require('./bindings');

// 由 uid 取出可信的身分。回傳 { uid, username }，不合格就丟 HttpsError。
async function requirePatient(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '請先登入');
  }
  const uid = request.auth.uid;
  const snap = await admin.firestore().collection('user_roles').doc(uid).get();
  if (!snap.exists) {
    throw new HttpsError('permission-denied', '查無身分資料');
  }
  const p = snap.data();
  if (p.status !== 'active') {
    throw new HttpsError('permission-denied', '帳號未啟用');
  }
  // 只有病患能綁 LINE。醫師端沒有用藥提醒可推，開放只會多一個攻擊面。
  if (p.role !== 'patient') {
    throw new HttpsError('permission-denied', '目前僅開放病患帳號綁定 LINE');
  }
  if (typeof p.username !== 'string' || !p.username) {
    throw new HttpsError('failed-precondition', '身分資料不完整');
  }
  return { uid, username: p.username };
}

exports.lineCreateLinkCode = onCall({ region: REGION }, async (request) => {
  const { uid, username } = await requirePatient(request);
  const { code, expiresAt } = await bindings.createLinkCode(uid, username);

  // 一鍵傳送連結：直接開啟 LINE 並把綁定碼填進輸入框，長輩只要按送出。
  // 這比「請把這 8 碼抄到 LINE 裡」少掉整整一個會出錯的步驟。
  const basicId = LINE_BASIC_ID.value();
  const sendUrl = basicId
    ? 'https://line.me/R/oaMessage/' + encodeURIComponent(basicId) + '/?' + encodeURIComponent(code)
    : null;
  const addFriendUrl = basicId
    ? 'https://line.me/R/ti/p/' + encodeURIComponent(basicId)
    : null;

  logger.info('產生綁定碼', { username });
  return { code, expiresAt, ttlMs: LINK_CODE_TTL_MS, sendUrl, addFriendUrl };
});

exports.lineUnbind = onCall({ region: REGION }, async (request) => {
  const { username } = await requirePatient(request);
  const r = await bindings.unbind(username);
  logger.info('解除綁定', { username, ok: r.ok });
  return { ok: r.ok, reason: r.reason || null };
});
