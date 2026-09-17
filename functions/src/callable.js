// 病患端網頁呼叫的 callable functions：產生綁定碼、解除綁定。
//
// 身分一律由 request.auth 取得，再回 Firestore 查 user_roles/{uid}。
// 前端傳來的任何 username / uid 都不採信——這正是原設計（讓前端自己寫
// line_link_codes）會造成帳號接管的地方，理由詳見 bindings.js 的長註解。

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');

const { REGION, LINE_BASIC_ID, LINK_CODE_TTL_MS, FAMILY_INVITE_TTL_MS } = require('./config');
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

// 透過 LINE 自助註冊的帳號（bindings.js 的 registerPatientViaLine()）沒有密碼——
// 唯一的登入方式就是這支 LINE。解除綁定等於自己把自己鎖在帳號外面，且沒有
// 「忘記密碼」這條後路可以救回來（帳號根本沒設過密碼），因此在這裡直接擋下，
// 不能只靠前端隱藏按鈕：呼叫端能繞過 UI 直接打這支 callable。
// 判斷方式與 patient.html 的 isPasswordlessAccount 相同（providerData 有無
// 'password'），只是這裡要用 Admin SDK 查，因為前端沒有其他使用者的 Auth 資料。
async function hasPassword(uid) {
  const user = await admin.auth().getUser(uid);
  return (user.providerData || []).some(p => p && p.providerId === 'password');
}

exports.lineUnbind = onCall({ region: REGION }, async (request) => {
  const { uid, username } = await requirePatient(request);
  if (!(await hasPassword(uid))) {
    throw new HttpsError('failed-precondition',
      '此帳號透過 LINE 註冊、沒有設定密碼，解除綁定會導致無法再登入，因此不開放解除綁定。');
  }
  const r = await bindings.unbind(username);
  logger.info('解除綁定', { username, ok: r.ok });
  return { ok: r.ok, reason: r.reason || null };
});

// 家屬邀請碼：只有病患能替自己的病歷邀請家屬（requirePatient() 同一道關卡），
// 產生的碼與病患自己綁定用的碼是不同集合、不同核銷語意，見 bindings.js
// createFamilyInviteCode() 的說明。relationshipLabel 是病患自己輸入的
// 備註（例如「女兒」），純顯示用途，不影響授權範圍。
exports.lineCreateFamilyInviteCode = onCall({ region: REGION }, async (request) => {
  const { uid, username } = await requirePatient(request);

  // 邀請家屬前，病患自己必須已經完成 LINE 綁定——家屬看得到的資料完全
  // 靠 LINE 傳送，一個從沒綁過 LINE 的病患邀請家屬，家屬核銷成功後卻永遠
  // 收不到任何跟這位病患有關的通知，且病患自己也無從得知邀請碼是否被領走。
  // LINE 自助註冊的帳號（registerPatientViaLine()）建立當下就會一併寫入
  // line_bindings.active=true，因此這裡單看 active 這一個欄位，就同時涵蓋
  // 「本身用 LINE 登入」與「帳密帳號另外完成綁定」兩種情況，不需要額外
  // 欄位分辨帳號來源。
  const binding = await bindings.getBinding(username);
  if (!binding || !binding.active) {
    throw new HttpsError('failed-precondition', '請先完成 LINE 綁定，才能邀請家屬查看您的資料');
  }

  const relationshipLabel = typeof request.data?.relationshipLabel === 'string'
    ? request.data.relationshipLabel.trim().slice(0, 20)
    : '';
  const { code, expiresAt } = await bindings.createFamilyInviteCode(uid, username, relationshipLabel);

  const basicId = LINE_BASIC_ID.value();
  const sendUrl = basicId
    ? 'https://line.me/R/oaMessage/' + encodeURIComponent(basicId) + '/?' + encodeURIComponent(code)
    : null;
  const addFriendUrl = basicId
    ? 'https://line.me/R/ti/p/' + encodeURIComponent(basicId)
    : null;

  logger.info('產生家屬邀請碼', { username, relationshipLabel });
  return { code, expiresAt, ttlMs: FAMILY_INVITE_TTL_MS, sendUrl, addFriendUrl };
});

exports._internal = { hasPassword, requirePatient };
