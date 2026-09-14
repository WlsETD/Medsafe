// 綁定資料的讀寫。所有函式都用 Admin SDK，因此不受 firestore.rules 管轄——
// 這四個集合在規則層對所有前端一律關閉（見 firestore.rules 的 LINE 一節），
// 唯一的寫入者就是這個檔案。

const admin = require('firebase-admin');
const crypto = require('crypto');
const { LINK_CODE_TTL_MS, FAMILY_INVITE_TTL_MS, FAMILY_CONSENT_TTL_MS } = require('./config');

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

// 由 uid 查 user_roles.role。webhook 用來判斷「這支已綁定的 LINE 帳號
// 是病患本人、還是家屬檢視身分」——家屬帳號沒有自己的 patient_data，
// 誤觸病患專屬的指令（藥箱查詢、下次回診等）必須被攔下，不能讓它們
// 照舊制路徑去讀一份根本不存在的病歷。
async function roleOf(uid) {
  const snap = await db().collection('user_roles').doc(uid).get();
  return snap.exists ? snap.data().role : null;
}

// ── 家屬邀請碼：與病患自己的綁定碼同一種碼形狀，但集合與核銷語意都
// 是獨立的（見 firestore.rules 家屬邀請碼一節的說明，不重複展開）。
async function createFamilyInviteCode(uid, username, relationshipLabel) {
  const code = randomCode();
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + FAMILY_INVITE_TTL_MS);
  await db().collection('family_invite_codes').doc(code).set({
    patient: username,
    patientUid: uid,
    relationshipLabel: relationshipLabel || '',
    expiresAt,
    used: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { code, expiresAt: expiresAt.toMillis() };
}

// 核銷家屬邀請碼。回傳 { ok, reason?, patient?, familyUsername?, relationshipLabel? }。
//
// 與 redeemLinkCode 同樣用交易包住「檢查是否用過」與「標記已用」，
// 理由相同（防止同一組碼被連續送達兩次時各自核銷一輪）。
//
// 【一支 LINE 帳號同一時間只能是一個 MedSafe 身分】
// line_users/{lineUserId} 只存一組 {username, uid}，這是既有病患綁定
// 本來就有的限制（見檔頭核銷邏輯），家屬邀請碼沿用同一把索引，因此
// 同一支 LINE 帳號：
//   ・若還沒綁過任何身分 → 全新建立一個沒有密碼的家屬帳號。
//   ・若已經是某位病患的家屬身分 → 直接沿用，同一支 LINE 可以看多位病患
//     （同一個 family username 底下累積多筆 family_consents）。
//   ・若已經是某位病患本人（role=='patient'）→ 拒絕。不能自己邀自己，
//     也不能讓「本人」與「別人的家屬」共用同一支 LINE，否則核銷 Custom
//     Token 時無法判斷這支 LINE 這一刻該換發哪一個身分。
async function redeemFamilyInviteCode(code, lineUserId) {
  const codeRef = db().collection('family_invite_codes').doc(code);

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
      usedByLineUserId: lineUserId
    });

    return { ok: true, patient: data.patient, relationshipLabel: data.relationshipLabel || '' };
  });

  if (!outcome.ok) return outcome;
  const { patient, relationshipLabel } = outcome;

  const existing = await findByLineUserId(lineUserId);
  let familyUsername, familyUid;

  if (existing) {
    const role = await roleOf(existing.uid);
    if (role !== 'family') {
      return { ok: false, reason: 'already-bound-other-role' };
    }
    if (existing.username === patient) {
      return { ok: false, reason: 'self-invite' };
    }
    familyUsername = existing.username;
    familyUid = existing.uid;
  } else {
    // 全新家屬身分：不設 email/password 的 Firebase Auth 使用者——
    // 之後唯一的登入方式永遠是 LIFF 換發的 Custom Token（見 exchange.js），
    // 跟病患自己的 LIFF 綁定完全同一套機制，只是身分的建立時機不同
    // （病患是自助註冊時就有帳號，家屬帳號要等第一次核銷邀請碼才存在）。
    const authUser = await admin.auth().createUser({});
    familyUid = authUser.uid;
    familyUsername = 'family_' + crypto.randomBytes(6).toString('hex');
    await db().collection('user_roles').doc(familyUid).set({
      username: familyUsername, role: 'family', status: 'active'
    });
    await db().collection('line_users').doc(lineUserId).set({ username: familyUsername, uid: familyUid });
  }

  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + FAMILY_CONSENT_TTL_MS);
  await db().collection('family_consents').doc(patient + '__' + familyUsername).set({
    patient,
    family: familyUsername,
    relationshipLabel,
    grantedAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt,
    revokedAt: null,
    sourceCode: code
  });

  return { ok: true, patient, familyUsername, relationshipLabel };
}

// 首次用 LINE 登入、尚未有任何帳號時的自助註冊。
//
// 對照 js/db-service.js 的 registerPatient()：一般帳密註冊時使用者已經
// 用 createUserWithEmailAndPassword 拿到 request.auth，接下來三份文件由
// 病患自己的 client SDK 寫、firestore.rules 把關（isSelfRegisteringPatient／
// patientInitialDocIsClean）。這裡使用者在建立 Firebase Auth 帳號之前完全
// 沒有 request.auth 可以依附，沒有規則能檢查，因此整段改在 Admin SDK 裡
// 一次做完——也因此本函式寫出的三份文件形狀必須手動保持與
// registerPatient() 完全一致，否則系統裡會出現兩種長得不一樣的病患初始
// 資料（例如其中一種意外帶了 assignedDoctor，讓陌生醫師讀得到病歷）。
//
// username 唯一性用「建 Auth 帳號前後各檢查一次」而非單一 transaction：
// Admin Auth 的 createUser() 無法參與 Firestore transaction，因此無法把
// 「檢查 username 空閒」與「建立 Auth 帳號」做成一個原子操作。建立後才
// 發現被搶走的機率極低（兩人同時搶同一個 username），一旦發生就刪掉
// 剛建立的 Auth 帳號回滾，不留孤兒帳號——與 db-service.js registerPatient()
// 失敗時刪除 Auth 帳號是同一個理由。
//
// 【實測踩過的坑，別再改回去】Auth 帳號必須帶 email（username@medsafe.local，
// 跟 js/auth.js 的 toAuthEmail() 同一個規則），不能像 redeemFamilyInviteCode()
// 那樣建立完全不帶 email 的帳號。家屬帳號可以不帶 email，是因為家屬從來不需要
// 通過 firestore.rules 的 isOwnUsername()／ownsUsername()——那兩個函式檢查
// request.auth.token.email 是否等於 username + '@medsafe.local'。病患帳號
// 讀寫 patient_data、users、appointments、conversations……幾乎每個集合的規則
// 都靠 isOwnUsername() 把關，帳號沒有 email 時這些規則一律判定為「不是本人」，
// 一律拒絕——不會噴明顯的錯誤畫面，而是讓所有讀取默默失敗，UI 停在
// data() 的預設佔位資料（例如「王大明」）看起來像沒有真正登入成功。
// 第一版沒帶 email 就是這樣被實測抓到的。
async function registerPatientViaLine({ lineUserId, name, username }) {
  const usersRef = db().collection('users').doc(username);

  const pre = await usersRef.get();
  if (pre.exists) {
    const err = new Error('帳號已被使用');
    err.code = 'username-taken';
    throw err;
  }

  let authUser;
  try {
    authUser = await admin.auth().createUser({ email: username + '@medsafe.local' });
  } catch (e) {
    // 理論上不會發生：上面才確認 users/{username} 不存在，但 email 命名空間
    // 與 username 命名空間本應一一對應。若真的撞上（例如舊資料留下的孤兒
    // Auth 帳號），視同 username 已被使用，不視為系統錯誤。
    if (e && e.code === 'auth/email-already-exists') {
      const err = new Error('帳號已被使用');
      err.code = 'username-taken';
      throw err;
    }
    throw e;
  }
  const uid = authUser.uid;

  try {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(usersRef);
      if (snap.exists) {
        const err = new Error('帳號已被使用');
        err.code = 'username-taken';
        throw err;
      }

      tx.set(db().collection('user_roles').doc(uid), {
        username, name, role: 'patient', status: 'active'
      });
      tx.set(usersRef, { uid, name, role: 'patient', status: 'active' });
      // 形狀與 db-service.js registerPatient() 完全相同，包含刻意不寫
      // assignedDoctor 的理由（見該處註解）。
      tx.set(db().collection('patient_data').doc(username), {
        profile: {
          id: username, name, age: null, gender: '',
          healthSummary: '尚無用藥紀錄，請於回診時請醫師建立您的用藥檔案。',
          nextAppointment: ''
        },
        stats: { safetyScore: null, activeMeds: 0, aiChecksToday: 0, lastSync: '尚未同步' },
        medications: [],
        ddiAlerts: [],
        aiInsights: [],
        reminders: []
      });
      tx.set(db().collection('line_bindings').doc(username), {
        uid,
        username,
        lineUserId,
        active: true,
        linkedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.set(db().collection('line_users').doc(lineUserId), { username, uid });
    });
  } catch (e) {
    await admin.auth().deleteUser(uid).catch(() => {});
    throw e;
  }

  return { uid, username };
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
  registerPatientViaLine,
  findByLineUserId,
  getBinding,
  unbind,
  deactivateByLineUserId,
  reactivateByLineUserId,
  listActiveBindings,
  roleOf,
  createFamilyInviteCode,
  redeemFamilyInviteCode,
  CODE_LEN,
  ALPHABET
};
