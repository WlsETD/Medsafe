// 綁定資料的讀寫。所有函式都用 Admin SDK，因此不受 firestore.rules 管轄——
// 這四個集合在規則層對所有前端一律關閉（見 firestore.rules 的 LINE 一節），
// 唯一的寫入者就是這個檔案。

const admin = require('firebase-admin');
const crypto = require('crypto');
const { LINK_CODE_TTL_MS } = require('./config');

const db = () => admin.firestore();

// 綁定碼字母表：去掉 0/O/1/I/L 這些長輩最容易看錯抄錯的字元。
// 32 個字元 × 8 碼 ≈ 1.1 兆種組合，配上 10 分鐘有效期，
// 用 LINE 訊息暴力猜測在時間上不可行。
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LEN = 8;

function randomCode() {
  // 用 randomInt（拒絕取樣）而非 randomBytes % 31——後者會讓前幾個字元
  // 的出現機率略高，實務上不致被利用，但沒有理由把偏差寫進去。
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

// 【為什麼綁定碼由伺服器產生，而不是前端自己寫一份到 Firestore】
//
// 原本的規劃是讓病患端直接建立 line_link_codes/{code}，規則檢查
// 「username 是自己的」。那個設計有一個會導致完整帳號接管的漏洞：
// 文件裡還有一個 uid 欄位，而規則沒有辦法（也沒有）驗證它。
// 病患可以建立一份 { username: 我自己, uid: 受害者的 uid } 的碼，
// 綁定後 line_users 就會記成「我的 LINE → 受害者的 uid」，
// 之後 LIFF 換發 Custom Token 時拿到的就是受害者的身分。
//
// 第二個問題是文件 ID 由前端自選：碼一旦可預測，攻擊者只要把猜到的碼
// 傳給官方帳號，就能把自己的 LINE 綁到別人的帳號上。
//
// 兩個問題都源自「讓前端決定授權文件的內容」。改為伺服器產生之後，
// username 與 uid 都取自 request.auth（無法偽造），碼有足夠亂度，
// 而 line_link_codes 在規則層可以直接對所有人關閉——形狀更簡單也更安全。
async function createLinkCode(uid, username) {
  const code = randomCode();
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + LINK_CODE_TTL_MS);
  await db().collection('line_link_codes').doc(code).set({
    username,
    uid,
    expiresAt,
    used: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { code, expiresAt: expiresAt.toMillis() };
}

// 核銷綁定碼並建立雙向綁定。回傳 { ok, reason?, username? }。
//
// 用交易包住「檢查碼有沒有被用過」與「標記已用」，否則同一組碼被連續
// 送兩次時，兩次都會讀到 used:false 而各自完成一次綁定——第二次會把
// 另一個 LINE 帳號也綁到同一個病患身上。
async function redeemLinkCode(code, lineUserId) {
  const codeRef = db().collection('line_link_codes').doc(code);

  const outcome = await db().runTransaction(async (tx) => {
    const snap = await tx.get(codeRef);
    if (!snap.exists) return { ok: false, reason: 'not-found' };

    const data = snap.data();
    if (data.used) return { ok: false, reason: 'used' };
    if (!data.expiresAt || data.expiresAt.toMillis() < Date.now()) {
      return { ok: false, reason: 'expired' };
    }

    tx.update(codeRef, {
      used: true,
      usedAt: admin.firestore.FieldValue.serverTimestamp(),
      // 記下是哪個 LINE 帳號核銷的。碼本身不刪除（與本專案 appointments /
      // care_relations 的 delete:false 同一個理由：能被抹除的紀錄沒有證據價值）。
      usedByLineUserId: lineUserId
    });

    return { ok: true, username: data.username, uid: data.uid };
  });

  if (!outcome.ok) return outcome;

  const { username, uid } = outcome;

  // 一個病患同時只能綁一個 LINE 帳號。重新綁定時，舊的反向索引必須清掉，
  // 否則舊手機仍然能用 LIFF 換發 Custom Token 登入這個病患的帳號。
  const bindingRef = db().collection('line_bindings').doc(username);
  const prev = await bindingRef.get();
  if (prev.exists && prev.data().lineUserId && prev.data().lineUserId !== lineUserId) {
    await db().collection('line_users').doc(prev.data().lineUserId).delete().catch(() => {});
  }

  await bindingRef.set({
    uid,
    username,
    lineUserId,
    active: true,
    linkedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await db().collection('line_users').doc(lineUserId).set({ username, uid });

  return { ok: true, username };
}

async function findByLineUserId(lineUserId) {
  const snap = await db().collection('line_users').doc(lineUserId).get();
  return snap.exists ? snap.data() : null;
}

async function getBinding(username) {
  const snap = await db().collection('line_bindings').doc(username).get();
  return snap.exists ? snap.data() : null;
}

// 解除綁定。
//
// line_bindings 設 active:false 而不整筆刪除——與本專案處理照護關係、掛號、
// 稽核記錄的一貫立場相同：留下「這件事曾經發生過、並在何時被解除」的軌跡。
// 但 line_users 的反向索引必須真的刪掉：它是換發登入憑證的依據，
// 留著等於解除綁定後那支手機仍然登得進來。兩者的處置不同不是不一致，
// 是因為一個是紀錄、一個是鑰匙。
async function unbind(username) {
  const bindingRef = db().collection('line_bindings').doc(username);
  const snap = await bindingRef.get();
  if (!snap.exists) return { ok: false, reason: 'not-bound' };

  const lineUserId = snap.data().lineUserId;
  if (lineUserId) {
    await db().collection('line_users').doc(lineUserId).delete().catch(() => {});
  }
  await bindingRef.update({
    active: false,
    unlinkedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { ok: true, lineUserId };
}

// 封鎖官方帳號時由 webhook 呼叫。與主動解除綁定的差別：
// 這是對方單方面停止接收，綁定關係本身沒有被撤銷，因此反向索引保留——
// 之後重新加好友就能繼續用，不必再跑一次綁定流程。
async function deactivateByLineUserId(lineUserId) {
  const user = await findByLineUserId(lineUserId);
  if (!user) return { ok: false, reason: 'not-found' };
  await db().collection('line_bindings').doc(user.username).update({
    active: false,
    blockedAt: admin.firestore.FieldValue.serverTimestamp()
  }).catch(() => {});
  return { ok: true, username: user.username };
}

async function reactivateByLineUserId(lineUserId) {
  const user = await findByLineUserId(lineUserId);
  if (!user) return { ok: false, reason: 'not-found' };
  await db().collection('line_bindings').doc(user.username).update({
    active: true,
    blockedAt: admin.firestore.FieldValue.delete()
  }).catch(() => {});
  return { ok: true, username: user.username };
}

// 目前所有有效綁定（每日提醒卡的推播對象）。
// 刻意從 line_bindings 出發而不是掃 patient_data：綁定者是少數，
// 病患總數會成長，從小的那一邊出發才不會每天早上把整個病患集合讀一遍。
async function listActiveBindings() {
  const snap = await db().collection('line_bindings').where('active', '==', true).get();
  return snap.docs.map(d => ({ username: d.id, ...d.data() }));
}

module.exports = {
  createLinkCode,
  redeemLinkCode,
  findByLineUserId,
  getBinding,
  unbind,
  deactivateByLineUserId,
  reactivateByLineUserId,
  listActiveBindings,
  CODE_LEN,
  ALPHABET
};
