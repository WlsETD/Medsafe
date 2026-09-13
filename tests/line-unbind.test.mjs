// lineUnbind 的密碼閘門測試（functions/src/callable.js）。
//
// 這份測試守的是：透過 LINE 自助註冊、沒有密碼的帳號（bindings.js 的
// registerPatientViaLine()）不能解除 LINE 綁定——那是唯一的登入方式，解除等於
// 自己把自己鎖在帳號外面，且沒有密碼重設這條後路可以救回來。判斷方式
// （providerData 有無 'password'）與 patient.html 的 isPasswordlessAccount
// 是同一套邏輯，這裡測的是伺服器端那一半（不能只靠前端隱藏按鈕）。
//
// 直接測 hasPassword()／requirePatient() 這兩個匯出的純邏輯，而非透過
// onCall() 包出來的 lineUnbind 本身——與 admin-delete-user.test.mjs 測
// deleteUserCascade() 而非 adminDeleteUser 同一個理由：onCall 的包裝層
// 只是把 HttpsError 轉成 Functions 的標準錯誤格式，不是這裡要驗證的邏輯。
//
// 需要 Firestore + Auth 模擬器。執行：npm run test:unbind

import { createRequire } from 'module';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('需要 Firestore 與 Auth 模擬器（請用 npm run test:unbind 執行）');
  process.exit(1);
}

const require = createRequire(new URL('../functions/index.js', import.meta.url));
const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'medsafe-rules-test' });
const { hasPassword, requirePatient } = require('./src/callable.js')._internal;

const db = admin.firestore();
const auth = admin.auth();

const results = [];
const check = (name, cond, detail) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (detail || '')]);

// ── hasPassword()：帳號有沒有密碼 ────────────────────────────────────────
const uLineOnly = await auth.createUser({}); // 比照 registerPatientViaLine()：不帶 email、不帶密碼
const uWithPw = await auth.createUser({ email: 'withpw@medsafe.local', password: 'secret123' });
const uEmailNoPw = await auth.createUser({ email: 'emailonly@medsafe.local' }); // 帳密註冊但忘記給密碼的邊界情況

check('LINE 自助註冊（無 email 無密碼）的帳號 hasPassword 為 false',
  (await hasPassword(uLineOnly.uid)) === false);
check('有密碼的帳號 hasPassword 為 true',
  (await hasPassword(uWithPw.uid)) === true);
check('只有 email、沒有密碼的帳號 hasPassword 仍為 false',
  (await hasPassword(uEmailNoPw.uid)) === false);

// ── 模擬 lineUnbind() 的完整閘門：requirePatient() 之後接 hasPassword() ──
// 這裡重建 callable.js 裡 lineUnbind 本體做的兩步判斷，確保兩個匯出的
// 函式接在一起時行為正確，而不只是個別函式各自正確。
async function wouldAllowUnbind(uid) {
  const { uid: verifiedUid } = await requirePatient({ auth: { uid } });
  return hasPassword(verifiedUid);
}

await db.doc('user_roles/' + uLineOnly.uid).set(
  { username: 'lineonly', role: 'patient', status: 'active' });
await db.doc('user_roles/' + uWithPw.uid).set(
  { username: 'withpw', role: 'patient', status: 'active' });

check('完整閘門：LINE 自助註冊帳號 → 不允許解除綁定',
  (await wouldAllowUnbind(uLineOnly.uid)) === false);
check('完整閘門：帳密註冊帳號 → 允許解除綁定',
  (await wouldAllowUnbind(uWithPw.uid)) === true);

// --- 輸出 ---
console.log('');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '\n      ' + r[2] : '');
const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
