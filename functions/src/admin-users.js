// 管理員刪除使用者：把一個帳號與它在系統中所有「指向它」的資料一併移除，
// 包含 LINE 綁定、Firebase Auth 帳號與各種以 username 串起來的關係文件。
//
// 【為什麼一定要在伺服器端做，而不是 admin.html 直接用前端 SDK 刪】
//   一、Firebase Auth 帳號只有 Admin SDK 刪得掉——前端只能刪「自己」。
//       只刪 Firestore 不刪 Auth，會留下一個 email 被永久佔用的孤兒帳號。
//   二、line_bindings / line_users / line_link_codes / family_invite_codes
//       在規則層對所有前端關閉，本來就只有 Admin SDK 碰得到（見 bindings.js）。
//   三、appointments / care_relations / consents / family_consents / break_glass /
//       medication_discontinuations 在規則層是 delete:false（紀錄不可單方面抹除）。
//       這個立場針對的是「一般操作」，本函式是管理員明確要求的帳號刪除，
//       因此只在這條具名、留痕、僅限 admin 的伺服器端路徑上例外，
//       規則本身維持不變——前端依然刪不掉任何一筆。
//
// 【為什麼「連結資料」必須刪乾淨，不是只刪帳號就好】
// 這個系統的授權大量以 username 字串串接（care_relations 的 {病患}__{醫師}、
// family_consents、consents 的 insurer、conversations.participants、
// patient_data.assignedDoctor……）。帳號刪掉後 username 會被釋放，
// 之後任何人都能自助註冊同一個 username——若舊關係文件還在，新註冊者就會
// 直接繼承舊帳號的授權：讀得到舊醫師的病患病歷、被舊病患的家屬看到、
// 出現在別人的對話參與者名單裡。所以這裡刪的不是「髒資料」，是懸空的授權。
//
// 【刻意保留的】audit_logs 不刪：稽核紀錄是對「誰做過什麼」的證據，
// 包含這次刪除本身；刪帳號不應同時抹掉帳號曾經被怎麼存取過。
// 其他病患病歷裡「由這位醫師開立／停用」的處方與對話訊息也不刪——
// 那是別人的病歷內容，不是這個帳號的資料。
//
// 【順序】先切斷存取（停用 user_roles、撤銷 Auth token、刪 LINE 反向索引），
// 再清資料，最後才刪 Auth 帳號與 users/{username}。中途失敗時帳號已經無法使用，
// 而 users/{username} 仍在列表上，管理員可以直接再按一次刪除重試——
// 每一步都是冪等的（刪不存在的文件不會出錯）。

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { REGION } = require('./config');

const db = () => admin.firestore();
const BATCH_LIMIT = 400;

function toAuthEmail(username) {
  return String(username).trim().toLowerCase() + '@medsafe.local';
}

function isValidTargetUsername(u) {
  return typeof u === 'string' && u.length > 0 && u.length <= 64 && !u.includes('/');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// line_push_log 的鍵以 username 開頭（reminder.js 的 dailyLockKey、
// prescription.js 的 pairKey）。只用前綴範圍查詢會誤中 username 本身含
// 「__」的別人（a 的前綴 a__ 也是 a__b 的前綴），因此再用完整格式精確比對。
function isPushLogKeyOf(key, username) {
  const u = escapeRegExp(username);
  return new RegExp('^' + u + '__([0-9]{4}-[0-9]{2}-[0-9]{2}__daily|ddi__[^_]+_[^_]+)$').test(key);
}

async function uidsForUsername(username, usersDocData) {
  const uids = new Set();
  if (usersDocData && typeof usersDocData.uid === 'string' && usersDocData.uid) uids.add(usersDocData.uid);
  const roles = await db().collection('user_roles').where('username', '==', username).get();
  roles.docs.forEach(d => uids.add(d.id));
  const lineUsers = await db().collection('line_users').where('username', '==', username).get();
  lineUsers.docs.forEach(d => { if (d.data().uid) uids.add(d.data().uid); });
  try {
    const au = await admin.auth().getUserByEmail(toAuthEmail(username));
    uids.add(au.uid);
  } catch (e) {
    if (!e || e.code !== 'auth/user-not-found') throw e;
  }
  return [...uids];
}

// 收集「要刪的文件」與「要改的文件」，以路徑去重。
function makePlan() {
  const deletes = new Map();   // path -> { ref, label }
  const updates = new Map();   // path -> { ref, data, label }
  return {
    del(ref, label) { if (!deletes.has(ref.path)) deletes.set(ref.path, { ref, label }); },
    upd(ref, data, label) {
      const prev = updates.get(ref.path);
      updates.set(ref.path, { ref, data: Object.assign({}, prev && prev.data, data), label });
    },
    async delQuery(query, label) {
      const snap = await query.get();
      snap.docs.forEach(d => this.del(d.ref, label));
      return snap.docs;
    },
    deletes,
    updates
  };
}

async function commitPlan(plan) {
  const counts = {};
  const ops = [];
  for (const [path, u] of plan.updates) {
    if (plan.deletes.has(path)) continue;   // 整份要刪就不必先改
    ops.push(b => b.update(u.ref, u.data));
    counts['updated:' + u.label] = (counts['updated:' + u.label] || 0) + 1;
  }
  for (const d of plan.deletes.values()) {
    ops.push(b => b.delete(d.ref));
    counts[d.label] = (counts[d.label] || 0) + 1;
  }
  for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
    const batch = db().batch();
    ops.slice(i, i + BATCH_LIMIT).forEach(fn => fn(batch));
    await batch.commit();
  }
  return counts;
}

async function deleteAuthUsers(uids) {
  let n = 0;
  for (const uid of uids) {
    try { await admin.auth().deleteUser(uid); n++; }
    catch (e) { if (!e || e.code !== 'auth/user-not-found') throw e; }
  }
  return n;
}

// 病患被刪除後，只為這位病患存在的家屬帳號也要一起移除。
// 家屬帳號是核銷這位病患的邀請碼時才被建立的（見 bindings.js 的
// redeemFamilyInviteCode），沒有密碼、唯一的登入方式是 LINE。
// 若它仍持有其他病患的有效授權就保留，只刪掉指向被刪病患的那一份。
async function removeOrphanFamilyAccount(familyUsername) {
  const remaining = await db().collection('family_consents').where('family', '==', familyUsername).limit(1).get();
  if (!remaining.empty) return false;

  const plan = makePlan();
  const roles = await plan.delQuery(db().collection('user_roles').where('username', '==', familyUsername), 'user_roles');
  const uids = new Set(roles.filter(d => d.data().role === 'family').map(d => d.id));
  // 保險：同名但角色不是 family 的文件不動（理論上不會發生，family_ 前綴是伺服器產生的）
  for (const d of roles) if (d.data().role !== 'family') plan.deletes.delete(d.ref.path);
  if (!uids.size) return false;
  const lineDocs = await db().collection('line_users').where('username', '==', familyUsername).get();
  lineDocs.docs.forEach(d => plan.del(d.ref, 'line_users'));
  await commitPlan(plan);
  await deleteAuthUsers([...uids]);
  return true;
}

// 【對外】刪除一位使用者與其所有連結資料。actor 為執行者 { uid, username, name }。
async function deleteUserCascade(username, actor) {
  if (!isValidTargetUsername(username)) {
    throw new HttpsError('invalid-argument', '帳號格式不正確');
  }
  if (actor && actor.username === username) {
    throw new HttpsError('failed-precondition', '不能刪除自己正在使用的帳號');
  }

  const usersRef = db().collection('users').doc(username);
  const usersSnap = await usersRef.get();
  const usersData = usersSnap.exists ? usersSnap.data() : null;
  const uids = await uidsForUsername(username, usersData);
  if (!usersData && !uids.length) {
    throw new HttpsError('not-found', '查無此帳號');
  }

  // user_roles 才是規則採信的身分，users 只是列表——兩邊任一邊寫著 admin 都拒絕，
  // 避免「列表顯示 patient、實際是 admin」的不一致被拿來繞過限制。
  const roleSnaps = await Promise.all(uids.map(uid => db().collection('user_roles').doc(uid).get()));
  const roles = new Set(roleSnaps.filter(s => s.exists).map(s => s.data().role));
  if (usersData && usersData.role) roles.add(usersData.role);
  if (roles.has('admin')) {
    throw new HttpsError('permission-denied', '不能刪除管理員帳號');
  }
  const role = usersData && usersData.role
    || (roleSnaps.find(s => s.exists) || { data: () => ({}) }).data().role || 'unknown';

  // ── 一、先切斷存取 ────────────────────────────────────────────────
  // 停用 user_roles 讓所有規則立即失效（isActive() 不再成立），
  // 撤銷 refresh token 讓已登入的裝置無法再續期，
  // 刪 line_users 讓 LIFF 無法再換發 Custom Token。
  // 反向索引只刪「目前確實指向這個 username」的那幾份。line_bindings 裡的
  // lineUserId 可能是解除綁定後殘留的舊值，那支 LINE 之後可能已綁到別人身上——
  // 照舊值直接刪會把無關的另一位使用者一起解除綁定。
  const lineUsersByName = await db().collection('line_users').where('username', '==', username).get();
  const lineUserIds = new Set(lineUsersByName.docs.map(d => d.id));
  const hadLineBinding = (await db().collection('line_bindings').doc(username).get()).exists;
  {
    const batch = db().batch();
    roleSnaps.filter(s => s.exists).forEach(s => batch.update(s.ref, { status: 'disabled' }));
    lineUserIds.forEach(id => batch.delete(db().collection('line_users').doc(id)));
    await batch.commit();
  }
  for (const uid of uids) {
    await admin.auth().revokeRefreshTokens(uid).catch(e => {
      if (!e || e.code !== 'auth/user-not-found') throw e;
    });
  }

  // ── 二、收集所有連結資料 ──────────────────────────────────────────
  const plan = makePlan();
  const col = (name) => db().collection(name);

  // LINE
  plan.del(col('line_bindings').doc(username), 'line_bindings');
  lineUserIds.forEach(id => plan.del(col('line_users').doc(id), 'line_users'));
  await plan.delQuery(col('line_link_codes').where('username', '==', username), 'line_link_codes');
  const pushLogs = await col('line_push_log')
    .where(admin.firestore.FieldPath.documentId(), '>=', username + '__')
    .where(admin.firestore.FieldPath.documentId(), '<', username + '__\uf8ff')
    .get();
  pushLogs.docs.filter(d => isPushLogKeyOf(d.id, username)).forEach(d => plan.del(d.ref, 'line_push_log'));

  // 以病患身分被指向的資料
  plan.del(col('patient_data').doc(username), 'patient_data');
  plan.del(col('patient_summaries').doc(username), 'patient_summaries');
  plan.del(col('family_views').doc(username), 'family_views');
  plan.del(col('appointment_locks').doc(username), 'appointment_locks');
  await plan.delQuery(col('medication_discontinuations').where('patient', '==', username), 'medication_discontinuations');
  await plan.delQuery(col('appointments').where('patient', '==', username), 'appointments');
  await plan.delQuery(col('care_relations').where('patient', '==', username), 'care_relations');
  await plan.delQuery(col('break_glass').where('patient', '==', username), 'break_glass');
  await plan.delQuery(col('consents').where('patient', '==', username), 'consents');
  const familyConsents = await plan.delQuery(col('family_consents').where('patient', '==', username), 'family_consents');
  await plan.delQuery(col('family_invite_codes').where('patient', '==', username), 'family_invite_codes');
  await plan.delQuery(col('patient_index').where('username', '==', username), 'patient_index');
  await plan.delQuery(col('care_cases').where('patientId', '==', username), 'care_cases');

  // 以醫師身分被指向的資料
  plan.del(col('doctor_schedules').doc(username), 'doctor_schedules');
  await plan.delQuery(col('appointments').where('doctor', '==', username), 'appointments');
  await plan.delQuery(col('appointment_counters').where('doctor', '==', username), 'appointment_counters');
  await plan.delQuery(col('care_relations').where('doctor', '==', username), 'care_relations');
  await plan.delQuery(col('break_glass').where('doctor', '==', username), 'break_glass');
  const assigned = await col('patient_data').where('assignedDoctor', '==', username).get();
  assigned.docs.forEach(d => plan.upd(d.ref, {
    assignedDoctor: admin.firestore.FieldValue.delete(),
    assignedDoctorName: admin.firestore.FieldValue.delete()
  }, 'patient_data.assignedDoctor'));
  // 別的病患的對話串保留（那是對方的病歷），只把這個 username 從參與者名單拿掉，
  // 否則日後同名註冊的新帳號會直接讀得到整串對話。
  const convs = await col('conversations').where('participants', 'array-contains', username).get();
  convs.docs.filter(d => d.id !== username).forEach(d => plan.upd(d.ref, {
    participants: admin.firestore.FieldValue.arrayRemove(username)
  }, 'conversations.participants'));

  // 以保險端／家屬身分被指向的資料
  await plan.delQuery(col('consents').where('insurer', '==', username), 'consents');
  await plan.delQuery(col('family_consents').where('family', '==', username), 'family_consents');

  const counts = await commitPlan(plan);

  // 病患自己的對話串連同 messages 子集合整串刪除
  const convRef = col('conversations').doc(username);
  const convSnap = await convRef.get();
  const hasMessages = !(await convRef.collection('messages').limit(1).get()).empty;
  if (convSnap.exists || hasMessages) {
    await db().recursiveDelete(convRef);
    counts.conversations = 1;
  }

  // ── 三、只為這位病患存在的家屬帳號 ────────────────────────────────
  let familyAccountsRemoved = 0;
  const familyUsernames = new Set(familyConsents.map(d => d.data().family).filter(Boolean));
  for (const fu of familyUsernames) {
    if (await removeOrphanFamilyAccount(fu)) familyAccountsRemoved++;
  }

  // ── 四、最後才刪帳號本身 ──────────────────────────────────────────
  const authDeleted = await deleteAuthUsers(uids);
  {
    const batch = db().batch();
    uids.forEach(uid => batch.delete(col('user_roles').doc(uid)));
    batch.delete(usersRef);
    await batch.commit();
  }

  const summary = {
    username,
    role,
    counts,
    lineUnbound: hadLineBinding || lineUserIds.size > 0,
    authDeleted,
    familyAccountsRemoved
  };

  // 稽核記錄由伺服器寫，不交給前端：刪除帳號是最不可逆的管理動作，
  // 「前端選擇不寫就沒有紀錄」（audit_logs 規則註解記載的限制）在這裡不可接受。
  // 欄位形狀與 js/audit.js 的 log() 相同，稽核頁面不必另外處理。
  try {
    await col('audit_logs').add({
      actor: actor ? actor.username : null,
      actorRole: 'admin',
      actorName: actor && actor.name ? String(actor.name).slice(0, 64) : null,
      action: 'user_delete',
      target: username,
      detail: summary,
      at: admin.firestore.FieldValue.serverTimestamp(),
      ua: 'cloud-function:adminDeleteUser'
    });
    summary.audited = true;
  } catch (e) {
    logger.error('刪除帳號的稽核記錄寫入失敗', { username, error: e.message });
    summary.audited = false;
  }

  return summary;
}

// 由 uid 取出可信的管理員身分。與 richmenu.js 的 requireAdmin 相同，
// 但這裡還需要 username（擋「刪自己」與寫稽核的 actor），因此回傳 profile。
async function requireAdminProfile(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', '請先登入');
  const snap = await db().collection('user_roles').doc(request.auth.uid).get();
  const p = snap.exists ? snap.data() : null;
  if (!p || p.status !== 'active' || p.role !== 'admin') {
    throw new HttpsError('permission-denied', '僅限管理員操作');
  }
  return { uid: request.auth.uid, username: p.username, name: p.name };
}

const adminDeleteUser = onCall({ region: REGION, timeoutSeconds: 300 }, async (request) => {
  const actor = await requireAdminProfile(request);
  const username = request.data && request.data.username;
  try {
    const summary = await deleteUserCascade(username, actor);
    logger.info('管理員刪除使用者', { actor: actor.username, username, counts: summary.counts });
    return summary;
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error('刪除使用者失敗', { actor: actor.username, username, error: e.message });
    throw new HttpsError('internal', '刪除過程中發生錯誤，部分資料可能尚未清除；請再按一次刪除重試（重複執行是安全的）。');
  }
});

module.exports = {
  adminDeleteUser,
  deleteUserCascade,
  isPushLogKeyOf
};
