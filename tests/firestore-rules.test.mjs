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
