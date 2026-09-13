// 管理員刪除使用者（functions/src/admin-users.js 的 deleteUserCascade）的測試。
//
// 這份測試守的是：
//   一、管理員帳號、自己的帳號一律刪不掉（含「users 寫 patient、user_roles 寫 admin」的不一致）
//   二、病患的所有連結資料都被刪除，包含 LINE 綁定、Auth 帳號、對話子集合
//   三、刪除不會誤傷別人：同 username 前綴的推播鎖、殘留舊 lineUserId 已被別人綁走、
//       仍服務其他病患的家屬帳號、其他病患的病歷與對話
//   四、醫師被刪除後，別的病患的病歷與對話保留，但 assignedDoctor 與參與者名單中不再指向他
//       （否則日後同名註冊的新帳號會直接繼承這些授權）
//   五、audit_logs 不被刪除，並且留下一筆 user_delete
//
// 需要 Firestore + Auth 模擬器，用 Admin SDK 直接操作（與正式環境的 Cloud Function 同一條路徑）。
// 執行：npm run test:deleteuser

import { createRequire } from 'module';

// 這份測試會真的刪資料與 Auth 帳號。沒有模擬器環境變數時一律拒絕執行，
// 絕不讓它有機會連到正式專案。
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('需要 Firestore 與 Auth 模擬器（請用 npm run test:deleteuser 執行）');
  process.exit(1);
}

// 與 admin-users.js 解析到同一份 firebase-admin（functions/node_modules）
const require = createRequire(new URL('../functions/index.js', import.meta.url));
const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'medsafe-rules-test' });
const { deleteUserCascade, isPushLogKeyOf } = require('./src/admin-users.js');

const db = admin.firestore();
const auth = admin.auth();

const results = [];
const check = (name, cond, detail) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (detail || '')]);
const exists = async (path) => (await db.doc(path).get()).exists;
const authExists = async (uid) => { try { await auth.getUser(uid); return true; } catch (e) { return false; } };
async function codeOf(fn) {
  try { await fn(); return null; } catch (e) { return e.code || e.message; }
}

// ── 種入資料 ─────────────────────────────────────────────────────────
async function mkUser(username, role, { email = true, listed = true } = {}) {
  const u = await auth.createUser(email ? { email: username.toLowerCase() + '@medsafe.local' } : {});
  await db.doc('user_roles/' + u.uid).set({ username, name: username, role, status: 'active' });
  if (listed) await db.doc('users/' + username).set({ uid: u.uid, name: username, role, status: 'active' });
  return u.uid;
}

const uidBoss = await mkUser('boss', 'admin');
const uidAlice = await mkUser('alice', 'patient');
const uidBob = await mkUser('bob', 'patient');
const uidDr = await mkUser('drlee', 'doctor');
const uidIns = await mkUser('ins1', 'insurance');
const uidFx = await mkUser('family_x', 'family', { email: false, listed: false });
const uidFy = await mkUser('family_y', 'family', { email: false, listed: false });
// 列表寫 patient、身分索引寫 admin 的不一致帳號
const uidSneaky = await auth.createUser({ email: 'sneaky@medsafe.local' }).then(u => u.uid);
await db.doc('user_roles/' + uidSneaky).set({ username: 'sneaky', role: 'admin', status: 'active' });
await db.doc('users/sneaky').set({ uid: uidSneaky, role: 'patient', status: 'active' });

const boss = { uid: uidBoss, username: 'boss', name: 'boss' };
const now = admin.firestore.Timestamp.now();

const seed = {
  // alice 本人
  'patient_data/alice': { profile: { id: 'alice', name: 'Alice' }, medications: [], reminders: [] },
  'patient_summaries/alice': { username: 'alice' },
  'family_views/alice': { patient: 'alice' },
  'medication_discontinuations/alice__m1': { patient: 'alice', medId: 'm1' },
  'appointments/a1': { patient: 'alice', doctor: 'drlee', status: 'booked' },
  'appointment_locks/alice': { patient: 'alice', appointment: 'a1' },
  'care_relations/alice__drlee': { patient: 'alice', doctor: 'drlee', status: 'active' },
  'break_glass/alice__drlee': { patient: 'alice', doctor: 'drlee' },
  'consents/alice__ins1': { patient: 'alice', insurer: 'ins1' },
  'family_consents/alice__family_x': { patient: 'alice', family: 'family_x' },
  'family_consents/alice__family_y': { patient: 'alice', family: 'family_y' },
  'family_invite_codes/CODE1234': { patient: 'alice', used: false },
  'patient_index/A123456789': { username: 'alice' },
  'care_cases/c1': { patientId: 'alice' },
  'conversations/alice': { patient: 'alice', participants: ['alice', 'drlee'] },
  'conversations/alice/messages/m1': { from: 'patient', text: 'hi' },
  // LINE：line_bindings 裡是解除綁定後殘留的舊 lineUserId，那支 LINE 已綁給 carol
  'line_bindings/alice': { username: 'alice', uid: uidAlice, lineUserId: 'U_OLD', active: true },
  'line_users/U_ALICE': { username: 'alice', uid: uidAlice },
  'line_users/U_OLD': { username: 'carol', uid: 'uidCarol' },
  'line_link_codes/LINK1234': { username: 'alice', uid: uidAlice },
  'line_push_log/alice__2026-09-13__daily': { at: now },
  'line_push_log/alice__ddi__B01AA03_M01AE01': { at: now },
  'line_push_log/alice__b__2026-09-13__daily': { at: now },  // 屬於 username「alice__b」
  // 家屬：family_x 只服務 alice，family_y 還服務 bob
  'line_users/U_FX': { username: 'family_x', uid: uidFx },
  'line_users/U_FY': { username: 'family_y', uid: uidFy },
  'family_consents/bob__family_y': { patient: 'bob', family: 'family_y' },
  // bob 與醫師 drlee
  'patient_data/bob': { profile: { id: 'bob', name: 'Bob' }, medications: [{ name: 'Warfarin' }],
    assignedDoctor: 'drlee', assignedDoctorName: '李醫師' },
  'conversations/bob': { patient: 'bob', participants: ['bob', 'drlee'] },
  'conversations/bob/messages/m1': { from: 'doctor', text: '記得回診' },
  'appointments/b1': { patient: 'bob', doctor: 'drlee', status: 'booked' },
  'care_relations/bob__drlee': { patient: 'bob', doctor: 'drlee', status: 'active' },
  'doctor_schedules/drlee': { username: 'drlee', weekly: {} },
  'appointment_counters/drlee__2026-09-14__am': { doctor: 'drlee', dateKey: '2026-09-14', session: 'am', taken: 1 },
  'consents/bob__ins1': { patient: 'bob', insurer: 'ins1' },
  // 既有稽核記錄
  'audit_logs/old1': { actor: 'drlee', action: 'prescribe', target: 'alice' }
};
for (const [p, d] of Object.entries(seed)) await db.doc(p).set(d);

// ── 一、純函式 ───────────────────────────────────────────────────────
check('推播鎖鍵：本人的每日卡片鍵', isPushLogKeyOf('alice__2026-09-13__daily', 'alice'));
check('推播鎖鍵：本人的 DDI 警示鍵', isPushLogKeyOf('alice__ddi__B01AA03_M01AE01', 'alice'));
check('推播鎖鍵：username 為 alice__b 的鍵不算 alice 的', !isPushLogKeyOf('alice__b__2026-09-13__daily', 'alice'));
check('推播鎖鍵：username 含正則字元不會被當成萬用字元', !isPushLogKeyOf('aXb__2026-09-13__daily', 'a.b'));

// ── 二、拒絕的情況 ───────────────────────────────────────────────────
check('不能刪除管理員', await codeOf(() => deleteUserCascade('boss', { uid: 'other', username: 'boss2' })) === 'permission-denied');
check('不能刪除自己', await codeOf(() => deleteUserCascade('boss', boss)) === 'failed-precondition');
check('users 寫 patient 但 user_roles 寫 admin 時同樣拒絕',
  await codeOf(() => deleteUserCascade('sneaky', boss)) === 'permission-denied');
check('被拒絕的管理員帳號維持原狀（未被停用）',
  (await db.doc('user_roles/' + uidSneaky).get()).data().status === 'active');
check('查無帳號回 not-found', await codeOf(() => deleteUserCascade('nobody', boss)) === 'not-found');
check('帳號格式不正確回 invalid-argument', await codeOf(() => deleteUserCascade('a/b', boss)) === 'invalid-argument');

// ── 三、刪除病患 alice ──────────────────────────────────────────────
const aliceSummary = await deleteUserCascade('alice', boss);

const aliceGone = [
  'users/alice', 'user_roles/' + uidAlice,
  'patient_data/alice', 'patient_summaries/alice', 'family_views/alice',
  'medication_discontinuations/alice__m1', 'appointments/a1', 'appointment_locks/alice', 'care_relations/alice__drlee',
  'break_glass/alice__drlee', 'consents/alice__ins1', 'family_consents/alice__family_x',
  'family_consents/alice__family_y', 'family_invite_codes/CODE1234', 'patient_index/A123456789',
  'care_cases/c1', 'conversations/alice', 'conversations/alice/messages/m1',
  'line_bindings/alice', 'line_users/U_ALICE', 'line_link_codes/LINK1234',
  'line_push_log/alice__2026-09-13__daily', 'line_push_log/alice__ddi__B01AA03_M01AE01'
];
for (const p of aliceGone) check('刪除 alice 後不存在：' + p, !(await exists(p)));
check('alice 的 Firebase Auth 帳號已刪除', !(await authExists(uidAlice)));
check('回傳摘要標示已解除 LINE 綁定', aliceSummary.lineUnbound === true);

check('殘留舊 lineUserId 已綁給別人時，別人的反向索引不受影響', await exists('line_users/U_OLD'));
check('username 為 alice__b 的推播鎖不受影響', await exists('line_push_log/alice__b__2026-09-13__daily'));

check('只服務 alice 的家屬帳號 family_x：user_roles 已刪', !(await exists('user_roles/' + uidFx)));
check('只服務 alice 的家屬帳號 family_x：LINE 反向索引已刪', !(await exists('line_users/U_FX')));
check('只服務 alice 的家屬帳號 family_x：Auth 帳號已刪', !(await authExists(uidFx)));
check('回傳摘要計入 1 個被移除的家屬帳號', aliceSummary.familyAccountsRemoved === 1);
check('仍服務 bob 的家屬帳號 family_y 保留', await exists('user_roles/' + uidFy) && await exists('line_users/U_FY') && await authExists(uidFy));
check('bob 給 family_y 的授權保留', await exists('family_consents/bob__family_y'));

check('bob 的資料不受 alice 刪除影響', await exists('patient_data/bob') && await exists('users/bob') && await authExists(uidBob));
check('既有稽核記錄不被刪除', await exists('audit_logs/old1'));
{
  const logs = await db.collection('audit_logs').where('action', '==', 'user_delete').where('target', '==', 'alice').get();
  check('留下一筆 user_delete 稽核記錄，actor 為執行的管理員',
    logs.size === 1 && logs.docs[0].data().actor === 'boss');
}
check('重複刪除同一帳號回 not-found（不會誤刪其他東西）',
  await codeOf(() => deleteUserCascade('alice', boss)) === 'not-found');

// ── 四、刪除醫師 drlee ──────────────────────────────────────────────
await deleteUserCascade('drlee', boss);

for (const p of ['users/drlee', 'user_roles/' + uidDr, 'doctor_schedules/drlee',
  'appointment_counters/drlee__2026-09-14__am', 'appointments/b1', 'care_relations/bob__drlee']) {
  check('刪除 drlee 後不存在：' + p, !(await exists(p)));
}
check('drlee 的 Firebase Auth 帳號已刪除', !(await authExists(uidDr)));
{
  const bob = (await db.doc('patient_data/bob').get()).data();
  check('bob 的病歷保留，用藥不受影響', bob && bob.medications.length === 1);
  check('bob 的 assignedDoctor / assignedDoctorName 已移除',
    bob && !('assignedDoctor' in bob) && !('assignedDoctorName' in bob));
  const conv = (await db.doc('conversations/bob').get()).data();
  check('bob 的對話保留，但參與者名單不再含 drlee',
    conv && JSON.stringify(conv.participants) === JSON.stringify(['bob']));
  check('bob 對話中的醫師訊息保留（屬於 bob 的病歷）', await exists('conversations/bob/messages/m1'));
}

// ── 五、刪除保險端 ins1 ─────────────────────────────────────────────
await deleteUserCascade('ins1', boss);
check('刪除 ins1 後，指向它的同意書已刪除', !(await exists('consents/bob__ins1')));
check('ins1 的 Firebase Auth 帳號已刪除', !(await authExists(uidIns)));
check('管理員帳號自始至終不受影響', await exists('users/boss') && await authExists(uidBoss));

// --- 輸出 ---
console.log('');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '\n      ' + r[2] : '');
const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
