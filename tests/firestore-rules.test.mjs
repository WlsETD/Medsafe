import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp, query, where } from 'firebase/firestore';
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
  await setDoc(doc(db, 'user_roles/uidAdm'), { username: 'admin', name: '管理員', role: 'admin', status: 'active' });
  // 處方閘門測試專用的病歷。與 P001 分開，避免前面的測試改動用藥清單長度後
  // 影響後續斷言——閘門規則的判斷正是以「清單是否變長」為準。
  await setDoc(doc(db, 'patient_data/P900'), {
    profile: { id: 'P900', name: '閘門測試' },
    medications: [{ name: 'Warfarin' }],
    ddiAlerts: [], reminders: [], assignedDoctor: 'doctor'
  });
  // 同意機制測試資料（P1-6）
  const future = Timestamp.fromDate(new Date(Date.now() + 30 * 86400000));
  const past = Timestamp.fromDate(new Date(Date.now() - 86400000));
  // P001 已授權 insurance01；atk 的同意已過期；P900 已撤回
  await setDoc(doc(db, 'consents/P001__insurance01'), {
    patient: 'P001', insurer: 'insurance01', scope: 'underwriting-summary',
    grantedAt: new Date(), expiresAt: future, revokedAt: null });
  await setDoc(doc(db, 'consents/atk__insurance01'), {
    patient: 'atk', insurer: 'insurance01', scope: 'underwriting-summary',
    grantedAt: new Date(), expiresAt: past, revokedAt: null });
  await setDoc(doc(db, 'consents/P900__insurance01'), {
    patient: 'P900', insurer: 'insurance01', scope: 'underwriting-summary',
    grantedAt: new Date(), expiresAt: future, revokedAt: new Date() });
  for (const u of ['P001', 'atk', 'P900']) {
    await setDoc(doc(db, 'patient_summaries/' + u), {
      username: u, displayName: u, ageBand: '65–74 歲', medicationCount: 3,
      alertCount: 0, safetyScore: 92, scoreStatus: 'assessed',
      attestedBy: u, attestedAt: new Date() });
  }
  // 稽核記錄不可竄改的測試對象：一筆已存在的記錄
  await setDoc(doc(db, 'audit_logs/existing'), {
    actor: 'doctor', actorRole: 'doctor', action: 'prescribe', at: new Date()
  });
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
const ADM = () => ctxFor('uidAdm', 'admin@medsafe.local').firestore();

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
// Phase 4 起，新增用藥必須攜帶安全檢查紀錄。這條原本斷言的是舊的寬鬆行為，
// 現已改為「附上 safetyCheck 才允許」——規則變嚴，測試隨之記錄新的不變式。
const SAFE_CHECK = { verdict: 'no-known-interaction', checkedAt: '2026-09-02T00:00:00Z', by: 'doctor' };
await run('醫師新增用藥並附安全檢查紀錄',
  () => updateDoc(doc(DOC(), 'patient_data/P001'), { medications: [{ name: 'X' }, { name: 'Y', safetyCheck: SAFE_CHECK }] }), 'allow');
// 【已移除】原本這裡有一條「核保員讀病歷 → allow」，斷言的正是 P1-6 所描述的缺口：
// 核保員讀得到每一位病患的完整用藥史。該權限已於 2026-09-02 撤銷，
// 對應的新斷言在下方「病患同意機制」一節，改為 deny。
// 保留這段註解，是為了讓日後看到權限變嚴的人知道這是刻意的，而不是漏寫。

// ── 處方安全閘門（Phase 4 / 稽核報告 P1-1、P0-4）─────────────────────────
// 前端的「必須先檢測才能開立」是流程控制，繞過畫面直接呼叫 SDK 就沒了。
// 以下驗證資料層的獨立強制：無論由誰寫入，新增的用藥都必須可歸責。
const RISK_CHECK = { verdict: 'risk', topSeverity: 'major', checkedAt: '2026-09-02T00:00:00Z', by: 'doctor' };
const MED0 = { name: 'Warfarin' };

await run('未附安全檢查紀錄即新增用藥（繞過檢測直接開藥）',
  () => updateDoc(doc(DOC(), 'patient_data/P900'), { medications: [MED0, { name: '未檢測就開的藥' }] }), 'deny');

await run('結論為 risk 但未附覆蓋理由（無記錄的一鍵覆蓋）',
  () => updateDoc(doc(DOC(), 'patient_data/P900'), { medications: [MED0, { name: 'Aspirin', safetyCheck: RISK_CHECK }] }), 'deny');

await run('覆蓋理由過短（形同未填）',
  () => updateDoc(doc(DOC(), 'patient_data/P900'),
    { medications: [MED0, { name: 'Aspirin', safetyCheck: { ...RISK_CHECK, overrideReason: 'ok' } }] }), 'deny');

// admin 同樣受約束——「管理員繞過安全檢查開藥」不該是被允許的路徑
await run('管理員亦不得未附安全檢查紀錄即新增用藥',
  () => updateDoc(doc(ADM(), 'patient_data/P900'), { medications: [MED0, { name: 'admin 加的藥' }] }), 'deny');

await run('安全檢查的 verdict 不在允許值域內',
  () => updateDoc(doc(DOC(), 'patient_data/P900'),
    { medications: [MED0, { name: 'X', safetyCheck: { verdict: 'safe', checkedAt: 'x', by: 'doctor' } }] }), 'deny');

// 合法路徑不可被誤擋——閘門若把正常開立也擋住，醫師會繞道，防護等於不存在
await run('附覆蓋理由的高風險處方可開立',
  () => updateDoc(doc(DOC(), 'patient_data/P900'),
    { medications: [MED0, { name: 'Aspirin', safetyCheck: { ...RISK_CHECK, overrideReason: '已知此交互作用，評估後臨床效益大於風險' } }] }), 'allow');

await run('修改其他欄位而未動用藥清單，不受閘門限制',
  () => updateDoc(doc(DOC(), 'patient_data/P900'), { assignedDoctor: 'doctor2' }), 'allow');

await run('移除用藥（清單變短）不受閘門限制',
  () => updateDoc(doc(DOC(), 'patient_data/P900'), { medications: [] }), 'allow');

// ── 病患同意機制（稽核報告 P1-6）─────────────────────────────────────────
// 修復前：核保員讀得到每一位病患的完整用藥史，無同意、無關聯、無時效、無欄位限制。

// 第一道：保險端已完全失去病歷讀取權
await run('核保端讀取病患完整病歷（P1-6 的核心缺口）',
  () => getDoc(doc(INS(), 'patient_data/P001')), 'deny');

// 第二道：改讀摘要，但沒有同意就讀不到
await run('核保端讀取未取得同意的病患摘要',
  () => getDoc(doc(INS(), 'patient_summaries/P002')), 'deny');

await run('核保端讀取已取得同意的病患摘要',
  () => getDoc(doc(INS(), 'patient_summaries/P001')), 'allow');

// 時效與撤回：一份永久有效、無法撤回的同意書在個資法下形同未取得同意
await run('同意已過期時不得讀取摘要',
  () => getDoc(doc(INS(), 'patient_summaries/atk')), 'deny');

await run('同意已撤回時不得讀取摘要',
  () => getDoc(doc(INS(), 'patient_summaries/P900')), 'deny');

// 同意的授予只能由病患本人
await run('病患授予同意給保險端',
  () => setDoc(doc(P001(), 'consents/P001__insurance02'), {
    patient: 'P001', insurer: 'insurance02', scope: 'underwriting-summary',
    grantedAt: serverTimestamp(), expiresAt: Timestamp.fromDate(new Date(Date.now() + 86400000)),
    revokedAt: null }), 'allow');

await run('保險端自行建立同意書（自己授權給自己）',
  () => setDoc(doc(INS(), 'consents/P002__insurance01'), {
    patient: 'P002', insurer: 'insurance01', scope: 'underwriting-summary',
    grantedAt: serverTimestamp(), expiresAt: Timestamp.fromDate(new Date(Date.now() + 86400000)),
    revokedAt: null }), 'deny');

await run('病患替他人授予同意',
  () => setDoc(doc(P001(), 'consents/P002__insurance01'), {
    patient: 'P002', insurer: 'insurance01', scope: 'underwriting-summary',
    grantedAt: serverTimestamp(), expiresAt: Timestamp.fromDate(new Date(Date.now() + 86400000)),
    revokedAt: null }), 'deny');

// 文件 ID 與內容不符：可用「內容寫 A、ID 寫 B」讓規則的 O(1) 查找指向錯誤的授權
await run('同意書的文件 ID 與內容不一致',
  () => setDoc(doc(P001(), 'consents/P001__insuranceX'), {
    patient: 'P001', insurer: 'insurance01', scope: 'underwriting-summary',
    grantedAt: serverTimestamp(), expiresAt: Timestamp.fromDate(new Date(Date.now() + 86400000)),
    revokedAt: null }), 'deny');

await run('授予時即宣稱已撤回（狀態不一致的同意書）',
  () => setDoc(doc(P001(), 'consents/P001__insurance03'), {
    patient: 'P001', insurer: 'insurance03', scope: 'underwriting-summary',
    grantedAt: serverTimestamp(), expiresAt: Timestamp.fromDate(new Date(Date.now() + 86400000)),
    revokedAt: serverTimestamp() }), 'deny');

// 撤回只能由病患，且只能改 revokedAt
await run('病患撤回自己給出的同意',
  () => updateDoc(doc(P001(), 'consents/P001__insurance01'), { revokedAt: serverTimestamp() }), 'allow');

await run('保險端撤改同意書（延長自己的授權）',
  () => updateDoc(doc(INS(), 'consents/P900__insurance01'),
    { expiresAt: Timestamp.fromDate(new Date(Date.now() + 86400000)) }), 'deny');

await run('刪除同意書（同意與撤回的歷程必須保存）',
  () => deleteDoc(doc(P001(), 'consents/P001__insurance02')), 'deny');

// 摘要的欄位白名單：少了它，摘要會逐漸長回一份完整病歷
await run('病患發布自己的核保摘要',
  () => setDoc(doc(P001(), 'patient_summaries/P001'), {
    username: 'P001', displayName: '張小泉', ageBand: '65–74 歲', medicationCount: 3,
    alertCount: 1, safetyScore: 88, scoreStatus: 'assessed',
    attestedBy: 'P001', attestedAt: serverTimestamp() }), 'allow');

await run('摘要夾帶白名單外的欄位（藥名清單）',
  () => setDoc(doc(P001(), 'patient_summaries/P001'), {
    username: 'P001', displayName: '張小泉', ageBand: '65–74 歲', medicationCount: 3,
    alertCount: 1, safetyScore: 88, scoreStatus: 'assessed',
    medications: [{ name: 'Warfarin' }],
    attestedBy: 'P001', attestedAt: serverTimestamp() }), 'deny');

await run('病患竄改他人的核保摘要',
  () => setDoc(doc(P001(), 'patient_summaries/P002'), {
    username: 'P002', displayName: 'x', ageBand: null, medicationCount: 0,
    alertCount: 0, safetyScore: 100, scoreStatus: 'assessed',
    attestedBy: 'P002', attestedAt: serverTimestamp() }), 'deny');

await run('核保端自行撰寫病患摘要',
  () => setDoc(doc(INS(), 'patient_summaries/P001'), {
    username: 'P001', displayName: 'x', ageBand: null, medicationCount: 0,
    alertCount: 0, safetyScore: 20, scoreStatus: 'assessed',
    attestedBy: 'insurance01', attestedAt: serverTimestamp() }), 'deny');

await run('偽稱摘要由他人具結（attestedBy 不符）',
  () => setDoc(doc(P001(), 'patient_summaries/P001'), {
    username: 'P001', displayName: '張小泉', ageBand: null, medicationCount: 0,
    alertCount: 0, safetyScore: 100, scoreStatus: 'assessed',
    attestedBy: 'doctor', attestedAt: serverTimestamp() }), 'deny');

// 核保端只能查到「授權對象是自己」的同意書，無法列舉他人的
await run('核保端查詢自己收到的同意書',
  () => getDocs(query(collection(INS(), 'consents'), where('insurer', '==', 'insurance01'))), 'allow');

await run('核保端列舉全部同意書（不帶 insurer 條件）',
  () => getDocs(collection(INS(), 'consents')), 'deny');

await run('核保端查詢他人收到的同意書',
  () => getDocs(query(collection(INS(), 'consents'), where('insurer', '==', 'insurance02'))), 'deny');

// ── 稽核軌跡（Phase 4 / 稽核報告 P1-5）───────────────────────────────────
const LOGS = (db) => collection(db, 'audit_logs');
const okLog = { actor: 'doctor', actorRole: 'doctor', action: 'prescribe', at: serverTimestamp() };

await run('以自己的身分寫入稽核記錄',
  () => addDoc(LOGS(DOC()), okLog), 'allow');

// 冒名是稽核軌跡最致命的攻擊：能把自己的行為記到別人頭上，記錄就沒有證據價值
await run('冒用他人身分寫入稽核記錄',
  () => addDoc(LOGS(DOC()), { ...okLog, actor: 'admin' }), 'deny');

await run('謊報自己的角色',
  () => addDoc(LOGS(DOC()), { ...okLog, actorRole: 'admin' }), 'deny');

// 用戶端自填時間即可偽造時序，讓「誰先誰後」失去意義
await run('以用戶端時間取代伺服器時間戳',
  () => addDoc(LOGS(DOC()), { ...okLog, at: new Date('2020-01-01') }), 'deny');

await run('缺少動作代碼的稽核記錄',
  () => addDoc(LOGS(DOC()), { actor: 'doctor', actorRole: 'doctor', at: serverTimestamp() }), 'deny');

// 不可竄改：這是稽核軌跡之所以能當證據的根本
await run('修改既有的稽核記錄',
  () => updateDoc(doc(DOC(), 'audit_logs/existing'), { action: '改成別的' }), 'deny');

await run('刪除既有的稽核記錄',
  () => deleteDoc(doc(DOC(), 'audit_logs/existing')), 'deny');

await run('管理員亦不得修改稽核記錄',
  () => updateDoc(doc(ADM(), 'audit_logs/existing'), { action: 'x' }), 'deny');

await run('管理員可讀取稽核記錄',
  () => getDocs(LOGS(ADM())), 'allow');

// 稽核記錄含其他使用者的操作軌跡，醫師不應能讀取全部
await run('醫師不可讀取稽核記錄',
  () => getDocs(LOGS(DOC())), 'deny');

await run('病患不可讀取稽核記錄',
  () => getDocs(LOGS(P001())), 'deny');

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
