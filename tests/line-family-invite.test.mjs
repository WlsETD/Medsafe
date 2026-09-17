// lineCreateFamilyInviteCode 的 LINE 綁定閘門測試（functions/src/callable.js）。
//
// 這份測試守的是：病患自己必須先完成 LINE 綁定，才能邀請家屬——家屬看得到
// 的資料完全靠 LINE 傳送，一個從沒綁過 LINE 的病患邀請家屬，家屬核銷成功後
// 卻永遠收不到任何通知，病患自己也無從得知邀請碼是否被領走。
//
// 跟 line-unbind.test.mjs 同一個做法：直接組合 requirePatient()（已匯出）
// 與 bindings.getBinding()（bindings.js 已匯出）這兩個既有的純邏輯，而不是
// 透過 onCall() 包出來的 lineCreateFamilyInviteCode 本身——onCall 的包裝層
// 只是把 HttpsError 轉成 Functions 的標準錯誤格式，不是這裡要驗證的邏輯。
//
// 需要 Firestore + Auth 模擬器。執行：npm run test:familyinvite

import { createRequire } from 'module';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('需要 Firestore 與 Auth 模擬器（請用 npm run test:familyinvite 執行）');
  process.exit(1);
}

const require = createRequire(new URL('../functions/index.js', import.meta.url));
const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'medsafe-rules-test' });
const { requirePatient } = require('./src/callable.js')._internal;
const bindings = require('./src/bindings.js');

const db = admin.firestore();
const auth = admin.auth();

const results = [];
const check = (name, cond, detail) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (detail || '')]);

// 重建 lineCreateFamilyInviteCode 本體做的兩步判斷：requirePatient() 之後
// 接「是否有已生效的 line_bindings」，確保兩者接在一起時行為正確。
async function wouldAllowInvite(uid) {
  const { username } = await requirePatient({ auth: { uid } });
  const binding = await bindings.getBinding(username);
  return !!(binding && binding.active);
}

const uNoBinding = await auth.createUser({ email: 'nobinding@medsafe.local', password: 'secret123' });
const uActiveBinding = await auth.createUser({ email: 'activebinding@medsafe.local', password: 'secret123' });
const uRevokedBinding = await auth.createUser({ email: 'revokedbinding@medsafe.local', password: 'secret123' });
const uLineNative = await auth.createUser({}); // 比照 registerPatientViaLine()：LINE 自助註冊沒有密碼

await db.doc('user_roles/' + uNoBinding.uid).set(
  { username: 'nobinding', role: 'patient', status: 'active' });
await db.doc('user_roles/' + uActiveBinding.uid).set(
  { username: 'activebinding', role: 'patient', status: 'active' });
await db.doc('user_roles/' + uRevokedBinding.uid).set(
  { username: 'revokedbinding', role: 'patient', status: 'active' });
await db.doc('user_roles/' + uLineNative.uid).set(
  { username: 'linenative', role: 'patient', status: 'active' });

// activebinding：像一般帳密病患另外完成 LINE 綁定
await db.doc('line_bindings/activebinding').set({
  uid: uActiveBinding.uid, username: 'activebinding', lineUserId: 'U_ACTIVE', active: true
});
// revokedbinding：曾經綁過，後來被封鎖/解除（active:false）
await db.doc('line_bindings/revokedbinding').set({
  uid: uRevokedBinding.uid, username: 'revokedbinding', lineUserId: 'U_REVOKED', active: false
});
// linenative：比照 registerPatientViaLine() 建帳當下就寫入的形狀
await db.doc('line_bindings/linenative').set({
  uid: uLineNative.uid, username: 'linenative', lineUserId: 'U_NATIVE', active: true
});
// nobinding：完全沒有 line_bindings 文件

check('沒有 line_bindings 文件的病患 → 不允許邀請家屬',
  (await wouldAllowInvite(uNoBinding.uid)) === false);
check('line_bindings.active===true 的病患 → 允許邀請家屬',
  (await wouldAllowInvite(uActiveBinding.uid)) === true);
check('line_bindings.active===false（已封鎖/解除）的病患 → 不允許邀請家屬',
  (await wouldAllowInvite(uRevokedBinding.uid)) === false);
check('LINE 自助註冊的帳號天生就有 active:true 的綁定 → 不需要額外步驟就允許邀請家屬',
  (await wouldAllowInvite(uLineNative.uid)) === true);

// --- 輸出 ---
console.log('');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '\n      ' + r[2] : '');
const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
