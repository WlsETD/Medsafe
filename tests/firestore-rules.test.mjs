import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import fs from 'fs';

// 直接讀專案根目錄的規則，確保測的就是會被部署的那一份
const RULES = fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');

const env = await initializeTestEnvironment({
  projectId: 'medsafe-rules-test',
  firestore: { rules: RULES, host: '127.0.0.1', port: 8080 }
});

// 種入既有資料（繞過規則）
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'user_roles/uidP001'), { username: 'P001', name: '張小泉', role: 'patient', status: 'active' });
  await setDoc(doc(db, 'user_roles/uidDoc'),  { username: 'doctor', name: '李醫師', role: 'doctor', status: 'active' });
  await setDoc(doc(db, 'user_roles/uidIns'),  { username: 'insurance01', name: '核保', role: 'insurance', status: 'active' });
  await setDoc(doc(db, 'user_roles/uidAtk'),  { username: 'atk', name: 'x', role: 'patient', status: 'active' });
  // 縱深防禦測試用：一份「uidForged 自稱 username 為 P001」的偽造身分索引。
  // 假設它已經以某種方式被寫進資料庫（舊版規則時期的殘留、或日後某條規則出現缺口），
  // 用來驗證 isOwnUsername() 的第二道 token.email 檢查是否真的能獨立擋下。
  await setDoc(doc(db, 'user_roles/uidForged'), { username: 'P001', name: '冒充者', role: 'patient', status: 'active' });
  await setDoc(doc(db, 'patient_data/P001'), {
    profile: { id: 'P001', name: '張小泉' },
    stats: { safetyScore: null },
    medications: [{ name: 'Warfarin' }],
    ddiAlerts: [],
    reminders: [],
    assignedDoctor: 'doctor'
  });
});

const ctxFor = (uid, email) => env.authenticatedContext(uid, { email });
const P001 = () => ctxFor('uidP001', 'p001@medsafe.local').firestore();
const ATK  = () => ctxFor('uidAtk',  'atk@medsafe.local').firestore();
const DOC  = () => ctxFor('uidDoc',  'doctor@medsafe.local').firestore();
const INS  = () => ctxFor('uidIns',  'insurance01@medsafe.local').firestore();
// 尚未建立 user_roles 的全新註冊者。每個測試各用一個 uid——
// 一旦某個測試在該 uid 上建檔成功，後續對同一份文件的寫入就會變成 update
// 而非 create，測到的將是另一條規則。
const NEW1 = () => ctxFor('uidNew1', 'newbie1@medsafe.local').firestore();
const NEW2 = () => ctxFor('uidNew2', 'newbie2@medsafe.local').firestore();
const NEW3 = () => ctxFor('uidNew3', 'newbie3@medsafe.local').firestore();
const NEW4 = () => ctxFor('uidNew4', 'newbie4@medsafe.local').firestore();
const FORGED = () => ctxFor('uidForged', 'forged@medsafe.local').firestore();

const results = [];
const run = async (name, fn, expect) => {
  try {
    await (expect === 'allow' ? assertSucceeds(fn()) : assertFails(fn()));
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, (e.message || '').slice(0, 110)]);
  }
};

// --- 合法路徑：不可被誤擋 ---
await run('病患讀自己病歷', () => getDoc(doc(P001(), 'patient_data/P001')), 'allow');
await run('病患更新 reminders', () => updateDoc(doc(P001(), 'patient_data/P001'), { reminders: [{ t: '08:00' }] }), 'allow');
await run('病患寫入自己的 fhirPseudonym', () => updateDoc(doc(P001(), 'patient_data/P001'), { fhirPseudonym: 'DEMO-ABC123' }), 'allow');
await run('病患更新 profile', () => updateDoc(doc(P001(), 'patient_data/P001'), { profile: { id: 'P001', name: '張小泉', age: 70 } }), 'allow');
await run('醫師寫 medications', () => updateDoc(doc(DOC(), 'patient_data/P001'), { medications: [{ name: 'X' }, { name: 'Y' }] }), 'allow');
await run('核保員讀病歷', () => getDoc(doc(INS(), 'patient_data/P001')), 'allow');

// 對立面警告的重點：只寫 fhirPseudonym 的建檔（getOrCreate 對不存在文件的行為）
// 若 size() 對缺欄位求值出錯，這一條會被誤擋 —— 那就是把合法使用者鎖在外面
await run('新病患僅以 fhirPseudonym 建檔（getOrCreate）',
  () => setDoc(doc(ATK(), 'patient_data/atk'), { fhirPseudonym: 'DEMO-NEW1' }), 'allow');

// --- 攻擊路徑：必須被擋 ---
await run('病患自寫 medications', () => updateDoc(doc(P001(), 'patient_data/P001'), { medications: [{ name: '自己加的' }] }), 'deny');
await run('病患自寫 ddiAlerts', () => updateDoc(doc(P001(), 'patient_data/P001'), { ddiAlerts: [{ severity: '無' }] }), 'deny');
await run('病患自寫 stats', () => updateDoc(doc(P001(), 'patient_data/P001'), { stats: { safetyScore: 100 } }), 'deny');
await run('病患改 assignedDoctor', () => updateDoc(doc(P001(), 'patient_data/P001'), { assignedDoctor: 'other' }), 'deny');
await run('病患覆寫既有 fhirPseudonym', () => updateDoc(doc(P001(), 'patient_data/P001'), { fhirPseudonym: 'DEMO-CHANGED' }), 'deny');
await run('病患讀他人病歷', () => getDoc(doc(P001(), 'patient_data/atk')), 'deny');
await run('核保員寫病歷', () => updateDoc(doc(INS(), 'patient_data/P001'), { reminders: [] }), 'deny');

// 對立面指出的硬漏洞：跳過 registerPatient，直接 create 自帶臨床資料的文件
await run('攻擊者 create 自帶 medications 的文件',
  () => setDoc(doc(ATK(), 'patient_data/atk2'), {
    profile: { id: 'atk2' }, medications: [{ name: '偽造用藥' }], ddiAlerts: [], assignedDoctor: 'doctor'
  }), 'deny');
await run('攻擊者 create 自帶 ddiAlerts 的文件',
  () => setDoc(doc(ATK(), 'patient_data/atk3'), {
    profile: { id: 'atk3' }, ddiAlerts: [{ severity: '無風險' }]
  }), 'deny');
await run('攻擊者 create 到別人的 username',
  () => setDoc(doc(ATK(), 'patient_data/P002'), { profile: { id: 'P002' } }), 'deny');


// --- P0-1 核心：user_roles 的身分宣告 ---
// 稽核報告 P0-1 的攻擊腳本第一步就在這裡：註冊任一帳號後，把自己的 username
// 宣告成受害者的，讓後續每一條 isOwnUsername() 都誤認自己是對方。
// patient_data 的規則測得再密都沒有意義——攻擊者是以「合法本人」的身分走進來的。
// 這一組測試是整份報告驗收標準指名要跑的那個腳本。
await run('攻擊者註冊時宣告他人的 username（P0-1 攻擊腳本第 2 步）',
  () => setDoc(doc(NEW1(), 'user_roles/uidNew1'),
    { username: 'P001', name: 'x', role: 'patient', status: 'active' }), 'deny');

await run('攻擊者自助註冊為 admin（垂直提權）',
  () => setDoc(doc(NEW2(), 'user_roles/uidNew2'),
    { username: 'newbie2', name: 'x', role: 'admin', status: 'active' }), 'deny');

await run('攻擊者寫入他人 uid 的身分索引',
  () => setDoc(doc(NEW3(), 'user_roles/uidDoc'),
    { username: 'newbie3', name: 'x', role: 'patient', status: 'active' }), 'deny');

await run('攻擊者以 users 文件佔用他人 username',
  () => setDoc(doc(NEW1(), 'users/P001'),
    { uid: 'uidNew1', name: 'x', role: 'patient', status: 'active' }), 'deny');

// 縱深防禦：就算偽造的身分索引真的存在於資料庫中，isOwnUsername() 仍要求
// token.email 對得上 username——Auth 簽發的 email 前端改不了，所以病歷依然讀不到。
// 這條測的是「單一防線失守後系統是否仍然安全」，而不是「防線有沒有失守」。
await run('偽造的 user_roles 仍無法讀取他人病歷（token.email 第二道防線）',
  () => getDoc(doc(FORGED(), 'patient_data/P001')), 'deny');

// 合法路徑不可被誤擋：username 與 Auth email 一致的正常自助註冊必須成功，
// 否則上面那些 deny 只是因為規則把所有人都擋光了。
await run('合法自助註冊（username 與 Auth email 一致）',
  () => setDoc(doc(NEW4(), 'user_roles/uidNew4'),
    { username: 'newbie4', name: '新使用者', role: 'patient', status: 'active' }), 'allow');

// 第 18 條：`allow update` 必須保有 resource != null 守衛。
//
// 【背景】Security Rules 的布林運算子是容錯的：`error || true` 的結果是 true 而非 error。
// 本專案已依賴此語意（自助註冊靠 isAdmin() 對不存在的 user_roles 求值錯誤被 || 吸收才成立）。
// 因此若 update 規則的 OR 鏈中，有任何分支在 resource 為 null 時為真，
// 原本靠求值錯誤擋住的路徑就會被靜默放行——而只斷言 allow/deny 的測試抓不到這種變化，
// 因為它要等到有人新增分支時才會發生。這條測試把守衛本身釘住。
//
// 【為何不斷言「日誌無 evaluation error」】曾如此嘗試，但已用 probe 實測證偽：
// 同一個運算式 profile().username == username（true）日誌乾淨，
// 而 profile().role == 'admin'（false）就會被報成 evaluation error；
// 回傳字面 false 的函式則乾淨。真正的求值錯誤不會取決於比較結果的真假，
// 故該訊息是 emulator 對「含 get()/diff() 且結果為 false」的回報用語，不是規則缺陷。
// 在那個訊號上做斷言只會製造永遠的紅燈或假綠燈。
{
  const src = fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const m = src.match(/match\s*\/patient_data\/\{username\}\s*\{[\s\S]*?\n\s*\}/);
  const block = m ? m[0] : '';
  const updateLine = (block.match(/allow update:[\s\S]*?;/) || [''])[0];
  const guarded = /allow update:\s*if\s+resource\s*!=\s*null\s*&&/.test(updateLine);
  results.push([guarded ? 'PASS' : 'FAIL',
                'patient_data 的 allow update 保有 resource != null 守衛',
                guarded ? '' : '守衛遺失：' + updateLine.slice(0, 120)]);
}

console.log('');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '\n      ' + r[2] : '');
const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
await env.cleanup();
process.exit(failed.length ? 1 : 0);
