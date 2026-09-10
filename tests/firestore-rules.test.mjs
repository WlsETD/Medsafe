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
  // 醫病對話測試資料（P1-4）
  // P001 與 doctor 的對話；atk 不在參與者名單中
  await setDoc(doc(db, 'conversations/P001'), {
    patient: 'P001', doctor: 'doctor', participants: ['P001', 'doctor'], createdAt: new Date() });
  await setDoc(doc(db, 'conversations/P001/messages/m1'), {
    from: 'patient', text: '我最近有點頭暈', at: new Date() });
  // 展示帳號重置的白名單測試專用資料。刻意不重用 conversations/P001——
  // 後面仍有測試依賴那份對話存在（如「病患送出訊息」），若在此處先把它
  // 刪掉會連帶弄壞那些無關的測試。改用兩份專用 fixture：
  //   conversations/patient01 —— 在白名單內（demo-reset 的重置對象）
  //   conversations/P900      —— 不在白名單內（既有病歷測試帳號，當對照組）
  await setDoc(doc(db, 'conversations/patient01'), {
    patient: 'patient01', doctor: 'doctor', participants: ['patient01', 'doctor'], createdAt: new Date() });
  await setDoc(doc(db, 'conversations/patient01/messages/m1'), {
    from: 'patient', text: '這是展示帳號的訊息', at: new Date() });
  await setDoc(doc(db, 'conversations/P900'), {
    patient: 'P900', doctor: 'doctor', participants: ['P900', 'doctor'], createdAt: new Date() });
  await setDoc(doc(db, 'conversations/P900/messages/m1'), {
    from: 'patient', text: '這不是展示帳號', at: new Date() });
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
// 化名值必須符合 _randomId() 的實際輸出格式（DEMO- + 12 碼大寫 hex）。
// 原本這裡用 'DEMO-ABC123' 這類簡寫佔位值，在格式檢查上線後會被正確擋下——
// 夾具寫得比正式產生器寬鬆，測的就不是真實流程。
await run('病患寫入自己的 fhirPseudonym', () => updateDoc(doc(P001(), 'patient_data/P001'), { fhirPseudonym: 'DEMO-A1B2C3D4E5F6' }), 'allow');
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

// 原本這裡改的是 assignedDoctor（改成 'doctor2'）。在醫師可無條件讀寫任何病歷的
// 時期沒有問題，但 S-1 修復後 assignedDoctor 決定授權，這一改會讓 DOC 失去對 P900
// 的權限，導致下一條測試連帶失敗——一個潛伏已久的測試間狀態污染。
// 改用不影響授權的欄位，測的仍是「未變動用藥清單時不受處方閘門限制」。
await run('修改其他欄位而未動用藥清單，不受閘門限制',
  () => updateDoc(doc(DOC(), 'patient_data/P900'), { stats: { activeMeds: 1 } }), 'allow');

await run('移除用藥（清單變短）不受閘門限制',
  () => updateDoc(doc(DOC(), 'patient_data/P900'), { medications: [] }), 'allow');

// ── 醫病對話（稽核報告 P1-4）─────────────────────────────────────────────
// 修復前對話全存在 localStorage，明文、無存取控制。移入 Firestore 後，
// 這一節驗證的是「誰讀得到、誰寫得了、寫下去能不能改」。
const MSGS = (db, pid) => collection(db, 'conversations/' + pid + '/messages');

await run('對話參與者讀取訊息（病患本人）',
  () => getDocs(MSGS(P001(), 'P001')), 'allow');

await run('對話參與者讀取訊息（主治醫師）',
  () => getDocs(MSGS(DOC(), 'P001')), 'allow');

// 這是 P1-4 的核心：原本任何人只要坐在同一台電腦前就讀得到全部對話
await run('非參與者讀取他人的醫病對話',
  () => getDocs(MSGS(ATK(), 'P001')), 'deny');

await run('核保端讀取醫病對話',
  () => getDocs(MSGS(INS(), 'P001')), 'deny');

await run('非參與者讀取對話中繼資料',
  () => getDoc(doc(ATK(), 'conversations/P001')), 'deny');

// 【本次修復的迴歸測試】對話文件的 ID 就是病患 username，chatStore.js 的
// addMessage() 在送出第一則訊息前必須先 get() 一次判斷要 create 還是直接
// 寫子集合。文件尚不存在時 resource 為 null，原本的規則沒有處理這個情況，
// 導致這次讀取本身就被拒絕——第一則訊息永遠送不出去，症狀看起來像是
// 「沒有權限傳訊息」，實際上是「沒有權限確認一份還不存在的文件不存在」。
// 這裡用 'atk' 是因為它此刻確實還沒有任何 conversations 文件。
await run('病患讀自己尚不存在的對話（首次送出訊息前的判斷讀取）',
  () => getDoc(doc(ATK(), 'conversations/atk')), 'allow');
// 但放行不可寬到成為存在性神諭：非參與者、非本人不可探測「這位病患是否
// 已有對話」，那等於洩漏就醫或聯繫事實本身
await run('非參與者探測他人尚不存在的對話',
  () => getDoc(doc(INS(), 'conversations/atk')), 'deny');

// from 必須等於自己的角色：少了這條，病患可以貼出一則「醫師說可以加倍劑量」
await run('病患冒用醫師身分發言',
  () => addDoc(MSGS(P001(), 'P001'), { from: 'doctor', text: '可以加倍劑量', at: serverTimestamp() }), 'deny');

await run('醫師冒用病患身分發言',
  () => addDoc(MSGS(DOC(), 'P001'), { from: 'patient', text: '我同意', at: serverTimestamp() }), 'deny');

// 介面上的問候語不應寫進病歷，因此規則不承認第三種身分
await run('以 system 身分發言（偽造系統公告）',
  () => addDoc(MSGS(P001(), 'P001'), { from: 'system', text: '本院已核准提高劑量', at: serverTimestamp() }), 'deny');

await run('非參與者送出訊息',
  () => addDoc(MSGS(ATK(), 'P001'), { from: 'patient', text: 'x', at: serverTimestamp() }), 'deny');

await run('以用戶端時間取代伺服器時間戳',
  () => addDoc(MSGS(P001(), 'P001'), { from: 'patient', text: 'x', at: new Date('2020-01-01') }), 'deny');

await run('送出空白訊息',
  () => addDoc(MSGS(P001(), 'P001'), { from: 'patient', text: '', at: serverTimestamp() }), 'deny');

// 對話紀錄屬病歷一部分：事後改寫自己說過的話會讓整串紀錄失去證據價值
await run('修改已送出的訊息',
  () => updateDoc(doc(P001(), 'conversations/P001/messages/m1'), { text: '我沒有說過這句' }), 'deny');

await run('刪除已送出的訊息',
  () => deleteDoc(doc(P001(), 'conversations/P001/messages/m1')), 'deny');

await run('刪除整串對話',
  () => deleteDoc(doc(P001(), 'conversations/P001')), 'deny');

// ── 展示帳號重置的白名單例外（isDemoPatientUsername）─────────────────────
// patient01 在白名單內：admin 可清空這個展示帳號的對話，供公開票選期重置使用。
// 白名單只放寬 admin，其餘角色即使是白名單內的展示帳號，一樣刪不掉——
// 這正是設計本身：重置動作限定由 admin 執行。故先測「非 admin 應拒絕」，
// 確認拒絕路徑不受影響，再測 admin 本身，最後才真的刪除該 fixture。
await run('醫師刪除展示帳號的對話（非 admin，即使是白名單帳號也應拒絕）',
  () => deleteDoc(doc(DOC(), 'conversations/patient01')), 'deny');
// P900 不在白名單內：即使呼叫者是 admin，一樣刪不掉——這是整個例外
// 是否真的「窄」的關鍵測試，不可只測正面案例。
await run('admin 刪除非展示帳號的對話訊息（白名單以外，應維持不可刪除）',
  () => deleteDoc(doc(ADM(), 'conversations/P900/messages/m1')), 'deny');
await run('admin 刪除非展示帳號的整串對話（白名單以外，應維持不可刪除）',
  () => deleteDoc(doc(ADM(), 'conversations/P900')), 'deny');
await run('admin 刪除展示帳號的對話訊息（重置用途）',
  () => deleteDoc(doc(ADM(), 'conversations/patient01/messages/m1')), 'allow');
await run('admin 刪除展示帳號的整串對話（重置用途）',
  () => deleteDoc(doc(ADM(), 'conversations/patient01')), 'allow');

// participants 是這串對話的存取控制清單，建立後不可變更——
// 否則任何參與者都能把第三人加進來，形同單方面轉發整串病歷對話
await run('事後把第三人加進參與者名單',
  () => updateDoc(doc(DOC(), 'conversations/P001'), { participants: ['P001', 'doctor', 'atk'] }), 'deny');

// 一串「病患不在參與者中」的病患對話，等於在病患不知情下建立的病歷
await run('建立不含病患本人的對話',
  () => setDoc(doc(DOC(), 'conversations/P002'), {
    patient: 'P002', doctor: 'doctor', participants: ['doctor'], createdAt: serverTimestamp() }), 'deny');

await run('建立自己不在其中的對話（替他人開對話）',
  () => setDoc(doc(ATK(), 'conversations/P003'), {
    patient: 'P003', doctor: 'doctor', participants: ['P003', 'doctor'], createdAt: serverTimestamp() }), 'deny');

// 合法路徑不可被誤擋
await run('病患送出訊息',
  () => addDoc(MSGS(P001(), 'P001'), { from: 'patient', text: '好的，謝謝醫師', at: serverTimestamp() }), 'allow');

await run('醫師回覆訊息',
  () => addDoc(MSGS(DOC(), 'P001'), { from: 'doctor', text: '請先觀察兩天', at: serverTimestamp() }), 'allow');

await run('病患建立自己與主治醫師的對話',
  () => setDoc(doc(ATK(), 'conversations/atk'), {
    patient: 'atk', doctor: 'doctor', participants: ['atk', 'doctor'], createdAt: serverTimestamp() }), 'allow');

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

// ── 重新授權（regrant，本次修復）────────────────────────────────────────
//
// 文件 ID 固定為 {病患}__{保險端}，撤回後若要再次授權同一保險端，寫入的
// 是同一個文件——Firestore 依「文件是否已存在」分辨 create/update，
// 不看客戶端呼叫的是 set() 還是 update()，因此永遠落在 update 規則裡，
// create 規則不會再被求值。修復前 update 只允許改 revokedAt 這一個欄位，
// 等於撤回是單向門：同一保險端一旦被撤回，病患再也無法重新打開，
// 只能改找別的保險端帳號——這在 DEPLOY_CHECKLIST 建議的「先撤回、
// 再重新授權」demo 流程中會直接卡死。
const regrantExpiry = Timestamp.fromDate(new Date(Date.now() + 30 * 86400000));
// 先測 cid 不符：此時文件仍處於上一步撤回後的狀態（revokedAt != null），
// 這樣才是真的在測 isConsentRegrant() 的 cid 檢查，而不是被
// 「文件目前非撤回狀態」這個更早的條件擋下
await run('重新授權時夾帶不同的保險端（內容與文件 ID 不符）',
  () => setDoc(doc(P001(), 'consents/P001__insurance01'), {
    patient: 'P001', insurer: 'insurance02', scope: 'underwriting-summary',
    grantedAt: serverTimestamp(), expiresAt: regrantExpiry, revokedAt: null }), 'deny');
await run('病患重新授權已撤回的同一保險端',
  () => setDoc(doc(P001(), 'consents/P001__insurance01'), {
    patient: 'P001', insurer: 'insurance01', scope: 'underwriting-summary',
    grantedAt: serverTimestamp(), expiresAt: regrantExpiry, revokedAt: null }), 'allow');
// 非撤回狀態（例如已過期但未撤回）的同意書不可被整批改寫——
// regrant 分支要求 resource.data.revokedAt != null，這條路徑仍然只認
// 「先撤回、才能重新授權」，不能用來繞過一般的 update 欄位限制
await run('非撤回狀態的同意書不可整批改寫',
  () => setDoc(doc(ATK(), 'consents/atk__insurance01'), {
    patient: 'atk', insurer: 'insurance01', scope: 'underwriting-summary',
    grantedAt: serverTimestamp(), expiresAt: regrantExpiry, revokedAt: null }), 'deny');

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
  () => setDoc(doc(ATK(), 'patient_data/atk'), { fhirPseudonym: 'DEMO-0123456789AB' }), 'allow');

// --- 攻擊路徑：必須被擋 ---
await run('病患自寫 medications', () => updateDoc(doc(P001(), 'patient_data/P001'), { medications: [{ name: '自己加的' }] }), 'deny');
await run('病患自寫 ddiAlerts', () => updateDoc(doc(P001(), 'patient_data/P001'), { ddiAlerts: [{ severity: '無' }] }), 'deny');
await run('病患自寫 stats', () => updateDoc(doc(P001(), 'patient_data/P001'), { stats: { safetyScore: 100 } }), 'deny');
await run('病患改 assignedDoctor', () => updateDoc(doc(P001(), 'patient_data/P001'), { assignedDoctor: 'other' }), 'deny');
// 用一個「格式完全合法、只是值不同」的化名，這條測的才是覆寫本身被擋，
// 而不是順帶被格式檢查擋掉——否則日後格式規則一鬆動，這條會靜默失去意義。
await run('病患覆寫既有 fhirPseudonym', () => updateDoc(doc(P001(), 'patient_data/P001'), { fhirPseudonym: 'DEMO-FFFFFFFFFFFF' }), 'deny');
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

// ── username 不可為身分證字號格式（本次修復）──────────────────────────
//
// 實測發現正式資料庫存在一個帳號 username 恰好是一組檢查碼有效的身分證字號
// （轉大寫後即為標準格式），且該值會被明文用於畫面顯示、聊天路由鍵與稽核
// actor 欄位，未受 patient_data.nationalId 的遮罩與查閱留痕保護。
// looksLikeNationalId() 只驗格式（不驗檢查碼），與 nationalIdFormatOk() 同一個理由。
const NIDUSER = () => ctxFor('uidNidUser', 'k223319166@medsafe.local').firestore();
await run('自助註冊 username 為身分證字號格式（user_roles）',
  () => setDoc(doc(NIDUSER(), 'user_roles/uidNidUser'),
    { username: 'k223319166', name: '測試', role: 'patient', status: 'active' }), 'deny');
await run('自助註冊 username 為身分證字號格式（users，大小寫不敏感）',
  () => setDoc(doc(NIDUSER(), 'users/K223319166'),
    { uid: 'uidNidUser', name: '測試', role: 'patient', status: 'active' }), 'deny');

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
  // 原本以非貪婪的 `{[\s\S]*?\n\s*\}` 擷取整個 match 區塊。該寫法假設區塊內
  // 沒有巢狀大括號——一旦在區塊內宣告函式（S-1 修復加入了 isAssignedDoctorOf），
  // 擷取會在該函式的右括號提前結束，於是找不到 allow update 而誤報守衛遺失。
  // 測試本身不該因為被測程式多了一個函式就失效，改為從 match 起點往後找第一條
  // allow update，不再嘗試判斷區塊在哪裡結束。
  const start = src.search(/match\s*\/patient_data\/\{username\}\s*\{/);
  const after = start === -1 ? '' : src.slice(start);
  const updateLine = (after.match(/allow update:[\s\S]*?;/) || [''])[0];
  const guarded = /allow update:\s*if\s+resource\s*!=\s*null\s*&&/.test(updateLine);
  results.push([guarded ? 'PASS' : 'FAIL',
                'patient_data 的 allow update 保有 resource != null 守衛',
                guarded ? '' : '守衛遺失：' + updateLine.slice(0, 120)]);
}

// ── 對抗性稽核補充報告（2026-09-03）的修復 ────────────────────────────────
//
// 這批測試釘住的共同性質是「權限的邊界」，而不是「權限的有無」。
// 原始規則對每個角色都問對了「你是誰」，卻沒有問「你能碰到多遠」——
// 醫師是醫師沒錯，但醫師該不該能列舉全站使用者？核保員是核保員沒錯，
// 但核保員該不該能刪光所有保單？這批缺陷全部落在這個縫隙裡。

const NEW5 = () => ctxFor('uidNew5', 'newbie5@medsafe.local').firestore();
const NEW6 = () => ctxFor('uidNew6', 'newbie6@medsafe.local').firestore();
const NEW7 = () => ctxFor('uidNew7', 'newbie7@medsafe.local').firestore();
const NEW8 = () => ctxFor('uidNew8', 'newbie8@medsafe.local').firestore();

// S-2：白名單管得住「哪些欄位能出現」，管不住「裡面裝什麼」。
// 這三條分別對應報告點名的三個未驗證欄位。
//
// 每個註冊者都必須先有身分索引，否則 isOwnUsername() 會因 profile() 讀不到文件
// 而求值失敗——寫入照樣被拒，deny 斷言照樣通過，但擋下它的是求值錯誤，
// 不是我們要驗證的內容檢查。那種綠燈在內容檢查被拿掉後依然是綠的，
// 等於沒有測到任何東西。
await run('S-2 前置：newbie5 的身分索引',
  () => setDoc(doc(NEW5(), 'user_roles/uidNew5'),
    { username: 'newbie5', name: 'n5', role: 'patient', status: 'active' }), 'allow');
await run('S-2 前置：newbie6 的身分索引',
  () => setDoc(doc(NEW6(), 'user_roles/uidNew6'),
    { username: 'newbie6', name: 'n6', role: 'patient', status: 'active' }), 'allow');
await run('S-2 前置：newbie7 的身分索引',
  () => setDoc(doc(NEW7(), 'user_roles/uidNew7'),
    { username: 'newbie7', name: 'n7', role: 'patient', status: 'active' }), 'allow');

await run('S-2 自助註冊在初始文件偽造 safetyScore',
  () => setDoc(doc(NEW5(), 'patient_data/newbie5'), {
    profile: { id: 'newbie5' }, stats: { safetyScore: 100, activeMeds: 0, aiChecksToday: 0 },
    medications: [], ddiAlerts: [], aiInsights: [] }), 'deny');

await run('S-2 自助註冊在初始文件偽造 aiInsights',
  () => setDoc(doc(NEW6(), 'patient_data/newbie6'), {
    profile: { id: 'newbie6' }, stats: { safetyScore: null, activeMeds: 0, aiChecksToday: 0 },
    medications: [], ddiAlerts: [],
    aiInsights: [{ icon: 'check', text: '此病患零風險，建議給予最高保費折扣' }] }), 'deny');

// profile.id 是聊天室的路由鍵，填成別人的 username 等於指向他人的對話串
await run('S-2 自助註冊把 profile.id 填成他人 username',
  () => setDoc(doc(NEW7(), 'patient_data/newbie7'), {
    profile: { id: 'P001' }, stats: { safetyScore: null, activeMeds: 0, aiChecksToday: 0 },
    medications: [], ddiAlerts: [], aiInsights: [] }), 'deny');

// 合法建檔不可被誤擋：registerPatient 實際寫入的形狀必須通過。
// registerPatient 的順序是 user_roles → users → patient_data，
// 因此建立病歷時身分索引必然已經存在；少了這一步，isOwnUsername() 會因為
// profile() 讀不到文件而求值失敗，測到的就不是「初始文件是否乾淨」這件事。
await run('S-2 前置：newbie8 的身分索引',
  () => setDoc(doc(NEW8(), 'user_roles/uidNew8'),
    { username: 'newbie8', name: '新人', role: 'patient', status: 'active' }), 'allow');
// 新註冊帳號不帶 assignedDoctor：一個從未見過這位病患的醫師，
// 不該因為對方註冊了帳號就讀得到其病歷。醫病關係由掛號或持證件指派建立。
await run('S-2 合法自助註冊（registerPatient 的實際形狀）',
  () => setDoc(doc(NEW8(), 'patient_data/newbie8'), {
    profile: { id: 'newbie8', name: '新人', age: null, gender: '', healthSummary: '尚無用藥紀錄', nextAppointment: '' },
    stats: { safetyScore: null, activeMeds: 0, aiChecksToday: 0, lastSync: '尚未同步' },
    medications: [], ddiAlerts: [], aiInsights: [], reminders: [] }), 'allow');

// 自助註冊者若能指定 assignedDoctor，就能單方面讓任一醫師讀得到自己的病歷，
// 也能把自己塞進他人的病患清單
await run('S-2 自助註冊指定 assignedDoctor',
  () => setDoc(doc(NEW7(), 'patient_data/newbie7c'), {
    profile: { id: 'newbie7c' }, medications: [], ddiAlerts: [], aiInsights: [],
    assignedDoctor: 'doctor' }), 'deny');

// H-6：affectedKeys() 只看頂層鍵，profile 是 map，子欄位改動在頂層只呈現為「profile 有變」
await run('H-6 病患把 profile.id 改成他人 username',
  () => updateDoc(doc(P001(), 'patient_data/P001'), { profile: { id: 'atk', name: '張小泉' } }), 'deny');
await run('H-6 病患改自己的 profile 其他欄位仍可放行',
  () => updateDoc(doc(P001(), 'patient_data/P001'), { profile: { id: 'P001', name: '張小泉', gender: '男' } }), 'allow');

// H-5：格式必須與 _randomId() 的輸出一致，否則等於沒有約束
await run('H-5 化名格式不符（長度不足）',
  () => updateDoc(doc(ATK(), 'patient_data/atk'), { fhirPseudonym: 'DEMO-ABC' }), 'deny');
await run('H-5 化名格式不符（非 hex 字元）',
  () => updateDoc(doc(ATK(), 'patient_data/atk'), { fhirPseudonym: 'DEMO-ZZZZZZZZZZZZ' }), 'deny');
await run('H-5 化名格式不符（無前綴）',
  () => updateDoc(doc(ATK(), 'patient_data/atk'), { fhirPseudonym: 'A1B2C3D4E5F6' }), 'deny');

// H-2：醫師對 users 的無限制列舉。取得病患是靠 patient_data 的 assignedDoctor 查詢，
// 不經過本集合，因此撤銷後醫師端沒有功能受影響。
await run('H-2 醫師列舉全系統使用者名冊', () => getDocs(collection(DOC(), 'users')), 'deny');
await run('H-2 醫師讀取他人的 users 文件', () => getDoc(doc(DOC(), 'users/P001')), 'deny');
await run('H-2 管理員仍可列舉使用者', () => getDocs(collection(ADM(), 'users')), 'allow');
await run('H-2 使用者仍可讀自己的 users 文件', () => getDoc(doc(P001(), 'users/P001')), 'allow');

// H-4：graph_data 與 ddi_rules 同屬知識庫，權限卻不一致——前門上鎖後門敞開
await run('H-4 醫師覆寫交互作用知識圖譜',
  () => setDoc(doc(DOC(), 'graph_data/main'), { nodes: [], links: [] }), 'deny');
await run('H-4 醫師仍可讀取知識圖譜', () => getDoc(doc(DOC(), 'graph_data/main')), 'allow');
await run('H-4 管理員仍可寫入知識圖譜',
  () => setDoc(doc(ADM(), 'graph_data/main'), { nodes: [], links: [] }), 'allow');

// H-3：write 涵蓋 delete。理賠與保單是財務憑證，個案紀錄是照護軌跡，
// 三者的共同性質是「事後必須查得到」——能被單一帳號無痕刪除就沒有證據價值。
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'insurance_claims/C1'), { customer: 'P001', amount: 'NT$ 100', status: '審核中' });
  await setDoc(doc(db, 'insurance_policies/POL1'), { customer: 'P001', name: '智慧健康險', amount: 'NT$ 120,000' });
  await setDoc(doc(db, 'care_cases/CC1'), { patientId: 'P001', status: '處理中' });
});
await run('H-3 核保端刪除理賠紀錄', () => deleteDoc(doc(INS(), 'insurance_claims/C1')), 'deny');
await run('H-3 核保端刪除保單紀錄', () => deleteDoc(doc(INS(), 'insurance_policies/POL1')), 'deny');
await run('H-3 核保端刪除個案紀錄', () => deleteDoc(doc(INS(), 'care_cases/CC1')), 'deny');
// 日常作業不可被誤擋：核保端仍須能建立與更新
await run('H-3 核保端仍可更新理賠狀態',
  () => updateDoc(doc(INS(), 'insurance_claims/C1'), { status: '已核准' }), 'allow');
await run('H-3 核保端仍可建立保單',
  () => setDoc(doc(INS(), 'insurance_policies/POL2'), { customer: 'P001', name: '長照專案' }), 'allow');
await run('H-3 管理員仍可刪除理賠紀錄', () => deleteDoc(doc(ADM(), 'insurance_claims/C1')), 'allow');

// ── 服藥回報 adherenceLog ──────────────────────────────────────────────
//
// 逐日服藥回報。性質上是病患自述，由病患本人寫入是正確的；
// 醫師讀得到（沿用既有的 patient_data 讀取權），但不該由核保端碰到——
// 那是臨床追蹤資料，不在核保摘要的最小必要欄位之內。
await run('adherenceLog 病患寫自己的服藥回報',
  () => updateDoc(doc(P001(), 'patient_data/P001'), {
    adherenceLog: { '2026-09-03': { total: 3, taken: [{ time: '08:00', text: '服用華法林', at: 1 }] } }
  }), 'allow');
await run('adherenceLog 病患寫他人的服藥回報',
  () => updateDoc(doc(P001(), 'patient_data/atk'), { adherenceLog: { '2026-09-03': { total: 3, taken: [] } } }), 'deny');
await run('adherenceLog 核保端寫入服藥回報',
  () => updateDoc(doc(INS(), 'patient_data/P001'), { adherenceLog: { '2026-09-03': { total: 3, taken: [] } } }), 'deny');
await run('adherenceLog 主治醫師讀得到病患的服藥回報',
  () => getDoc(doc(DOC(), 'patient_data/P001')), 'allow');
// 回報欄位不可成為夾帶臨床欄位的入口：affectedKeys() 的白名單必須照擋
await run('adherenceLog 夾帶 medications 一併寫入',
  () => updateDoc(doc(P001(), 'patient_data/P001'), {
    adherenceLog: { '2026-09-03': { total: 1, taken: [] } },
    medications: [{ name: '自己加的' }]
  }), 'deny');

// ── 掛號：醫病關係的來源 ────────────────────────────────────────────────
//
// 掛號這個動作本身就是授權事件。這批測試釘住的是「誰能建立、誰看得到、
// 誰能改」——尤其是「病患不能替別人掛號」與「不能事後改掛給別的醫師」。
// 後者若失守，等於能把一次已發生的就診轉記到他人名下。
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  const future = Timestamp.fromDate(new Date(Date.now() + 7 * 86400000));
  await setDoc(doc(db, 'appointments/AP1'), {
    patient: 'P001', patientName: '張小泉', doctor: 'doctor', doctorName: '李醫師',
    department: '心臟內科', scheduledAt: future, status: 'booked', createdAt: new Date(), note: ''
  });
  await setDoc(doc(db, 'appointments/AP2'), {
    patient: 'atk', patientName: 'x', doctor: 'otherdoc', doctorName: '他院醫師',
    department: '一般內科', scheduledAt: future, status: 'booked', createdAt: new Date(), note: ''
  });
});

const apptDoc = (extra) => Object.assign({
  patient: 'P001', patientName: '張小泉', doctor: 'doctor', doctorName: '李醫師',
  department: '一般內科', scheduledAt: Timestamp.fromDate(new Date(Date.now() + 86400000)),
  status: 'booked', createdAt: serverTimestamp(), note: ''
}, extra || {});

// 合法路徑
await run('掛號 病患替自己掛號',
  () => setDoc(doc(P001(), 'appointments/新1'), apptDoc()), 'allow');
await run('掛號 病患讀自己的掛號', () => getDoc(doc(P001(), 'appointments/AP1')), 'allow');
await run('掛號 醫師讀指向自己的掛號', () => getDoc(doc(DOC(), 'appointments/AP1')), 'allow');
await run('掛號 醫師以 where(doctor==自己) 列出',
  () => getDocs(query(collection(DOC(), 'appointments'), where('doctor', '==', 'doctor'))), 'allow');
await run('掛號 病患取消自己的掛號',
  () => updateDoc(doc(P001(), 'appointments/AP1'), { status: 'cancelled' }), 'allow');

// 攻擊路徑
await run('掛號 病患替他人掛號',
  () => setDoc(doc(P001(), 'appointments/新2'), apptDoc({ patient: 'atk' })), 'deny');
// status 若可自訂，病患能直接建立一筆「已完診」——在病歷中捏造不曾發生的診療
await run('掛號 病患自訂 status 為已完診',
  () => setDoc(doc(P001(), 'appointments/新3'), apptDoc({ status: 'finished' })), 'deny');
// createdAt 必須等於伺服器時間，不可回填造假時序
await run('掛號 病患回填 createdAt',
  () => setDoc(doc(P001(), 'appointments/新4'), apptDoc({ createdAt: Timestamp.fromDate(new Date(0)) })), 'deny');
await run('掛號 夾帶白名單外欄位',
  () => setDoc(doc(P001(), 'appointments/新5'), apptDoc({ priority: 'vip' })), 'deny');
await run('掛號 醫師讀他人掛號（未指向自己）',
  () => getDoc(doc(DOC(), 'appointments/AP2')), 'deny');
await run('掛號 醫師不受限地列舉全部掛號',
  () => getDocs(collection(DOC(), 'appointments')), 'deny');
await run('掛號 病患讀他人的掛號', () => getDoc(doc(P001(), 'appointments/AP2')), 'deny');
// 事後改掛給別的醫師 == 把一次就診轉記到他人名下
await run('掛號 病患事後改掛給其他醫師',
  () => updateDoc(doc(P001(), 'appointments/AP1'), { doctor: 'otherdoc' }), 'deny');
await run('掛號 核保端讀取掛號', () => getDoc(doc(INS(), 'appointments/AP1')), 'deny');
// 就診紀錄不可刪除：能被單方面抹除的紀錄沒有證據價值
await run('掛號 病患刪除掛號紀錄', () => deleteDoc(doc(P001(), 'appointments/AP1')), 'deny');
await run('掛號 管理員刪除掛號紀錄', () => deleteDoc(doc(ADM(), 'appointments/AP1')), 'deny');

// ── S-1 修復：醫師不再無條件讀得到任何病歷 ──────────────────────────────
//
// 這是本專案追蹤最久的缺口。原本 patient_data 的 allow read 是
// `isAdmin() || isDoctor() || isOwnUsername(username)`——isDoctor() 不帶任何
// 醫病關係檢查，任何醫師帳號可讀全系統每一份病歷。
//
// 這批測試釘住的性質是：**醫師必須有理由才讀得到**，而理由有兩種——
// 有效的照護關係（新制），或既有的 assignedDoctor 指派（過渡）。
// 兩者皆無時必須被擋下，包括今天還不存在的新病患。
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  const future = Timestamp.fromDate(new Date(Date.now() + 30 * 86400000));
  const past = Timestamp.fromDate(new Date(Date.now() - 86400000));
  // 與 doctor 有有效照護關係
  await setDoc(doc(db, 'care_relations/rel1__doctor'), {
    patient: 'rel1', doctor: 'doctor', status: 'active', grantedAt: new Date(), expiresAt: future });
  await setDoc(doc(db, 'patient_data/rel1'), {
    profile: { id: 'rel1', name: '有關係' }, medications: [], ddiAlerts: [], reminders: [] });
  // 關係已過期
  await setDoc(doc(db, 'care_relations/rel2__doctor'), {
    patient: 'rel2', doctor: 'doctor', status: 'active', grantedAt: new Date(), expiresAt: past });
  await setDoc(doc(db, 'patient_data/rel2'), {
    profile: { id: 'rel2', name: '已過期' }, medications: [], ddiAlerts: [], reminders: [] });
  // 關係已撤銷
  await setDoc(doc(db, 'care_relations/rel3__doctor'), {
    patient: 'rel3', doctor: 'doctor', status: 'revoked', grantedAt: new Date(), expiresAt: future });
  await setDoc(doc(db, 'patient_data/rel3'), {
    profile: { id: 'rel3', name: '已撤銷' }, medications: [], ddiAlerts: [], reminders: [] });
  // 完全沒有關係、也沒有 assignedDoctor
  await setDoc(doc(db, 'patient_data/nobody'), {
    profile: { id: 'nobody', name: '無關係' }, medications: [], ddiAlerts: [], reminders: [] });
  // 指派給別的醫師
  await setDoc(doc(db, 'patient_data/otherpt'), {
    profile: { id: 'otherpt', name: '他醫師的病患' }, assignedDoctor: 'otherdoc',
    medications: [], ddiAlerts: [], reminders: [] });
});

// 【核心】沒有任何理由時必須被擋下——這一條若失守，S-1 就沒有修好
await run('S-1 醫師讀無醫病關係的病歷', () => getDoc(doc(DOC(), 'patient_data/nobody')), 'deny');
await run('S-1 醫師讀指派給其他醫師的病歷', () => getDoc(doc(DOC(), 'patient_data/otherpt')), 'deny');
await run('S-1 醫師寫入無醫病關係的病歷',
  () => updateDoc(doc(DOC(), 'patient_data/nobody'), { reminders: [] }), 'deny');
// 只擋讀取是不夠的：沒有關係卻能寫入用藥，比讀取更危險
await run('S-1 醫師對無關係病歷新增用藥',
  () => updateDoc(doc(DOC(), 'patient_data/nobody'), {
    medications: [{ name: 'X', safetyCheck: { verdict: 'no-known-interaction', checkedAt: 'x', by: 'doctor' } }]
  }), 'deny');
// 時效與撤銷必須真的生效，否則等於永久授權
await run('S-1 照護關係已過期', () => getDoc(doc(DOC(), 'patient_data/rel2')), 'deny');
await run('S-1 照護關係已撤銷', () => getDoc(doc(DOC(), 'patient_data/rel3')), 'deny');
// 醫師不可自行建立關係替自己開門——那是自我授權
await run('S-1 醫師自行建立照護關係',
  () => setDoc(doc(DOC(), 'care_relations/nobody__doctor'), {
    patient: 'nobody', doctor: 'doctor', status: 'active',
    grantedAt: serverTimestamp(), expiresAt: Timestamp.fromDate(new Date(Date.now() + 86400000)) }), 'deny');

// 合法路徑不可被誤擋——擋錯人的代價是醫師打不開病歷
await run('S-1 有效照護關係可讀', () => getDoc(doc(DOC(), 'patient_data/rel1')), 'allow');
await run('S-1 有效照護關係可寫',
  () => updateDoc(doc(DOC(), 'patient_data/rel1'), { reminders: [{ t: '08:00' }] }), 'allow');
await run('S-1 舊制 assignedDoctor 仍可讀（過渡）',
  () => getDoc(doc(DOC(), 'patient_data/P001')), 'allow');
await run('S-1 病患仍可讀自己的病歷', () => getDoc(doc(P001(), 'patient_data/P001')), 'allow');
await run('S-1 管理員仍可讀任何病歷', () => getDoc(doc(ADM(), 'patient_data/nobody')), 'allow');

// 照護關係文件本身的邊界
await run('care_relations 病患授予自己的關係',
  () => setDoc(doc(P001(), 'care_relations/P001__doctor'), {
    patient: 'P001', doctor: 'doctor', status: 'active',
    grantedAt: serverTimestamp(), expiresAt: Timestamp.fromDate(new Date(Date.now() + 86400000)) }), 'allow');
await run('care_relations 病患替他人授予',
  () => setDoc(doc(P001(), 'care_relations/atk__doctor'), {
    patient: 'atk', doctor: 'doctor', status: 'active',
    grantedAt: serverTimestamp(), expiresAt: Timestamp.fromDate(new Date(Date.now() + 86400000)) }), 'deny');
// 內容與文件 ID 不一致時，規則的 O(1) 查找會指向錯誤的授權
await run('care_relations 文件 ID 與內容不符',
  () => setDoc(doc(P001(), 'care_relations/P001__doctor2'), {
    patient: 'P001', doctor: 'doctor', status: 'active',
    grantedAt: serverTimestamp(), expiresAt: Timestamp.fromDate(new Date(Date.now() + 86400000)) }), 'deny');
await run('care_relations 醫師讀指向自己的關係',
  () => getDoc(doc(DOC(), 'care_relations/rel1__doctor')), 'allow');

// ── 尚不存在的關係文件：第一次建立的前置讀取 ──────────────────────────
//
// 前端必須先讀一次 care_relations/{病患}__{醫師} 才知道該 create（新授權）
// 還是 update（續期）。文件不存在時 resource 為 null，若規則一律拒絕，
// 每一段照護關係的「第一次」都會失敗——掛號與臨櫃指派都會停在
// permission-denied。這四筆測試就是那個迴歸。
await run('care_relations 病患讀自己尚不存在的關係',
  () => getDoc(doc(P001(), 'care_relations/P001__newdoc')), 'allow');
await run('care_relations 醫師讀指名自己的尚不存在關係',
  () => getDoc(doc(DOC(), 'care_relations/newpatient__doctor')), 'allow');
// 但放行不可寬到成為存在性神諭：「拒絕」與「查無此文件」若可區分，
// 任何人都能逐一探測「某病患是否由某醫師照顧」，洩漏就醫事實本身。
await run('care_relations 病患探測他人的關係（存在）',
  () => getDoc(doc(P001(), 'care_relations/rel1__doctor')), 'deny');
await run('care_relations 病患探測他人的關係（不存在）',
  () => getDoc(doc(P001(), 'care_relations/rel1__newdoc')), 'deny');
// 後綴比對只對醫師開放：否則病患能探測「任何人與我」，
// 而病患本來就不該是關係中的醫師方
await run('care_relations 病患以自己為後綴探測',
  () => getDoc(doc(ATK(), 'care_relations/rel1__atk')), 'deny');
await run('care_relations 醫師探測不指名自己的關係',
  () => getDoc(doc(DOC(), 'care_relations/rel1__otherdoc')), 'deny');
await run('care_relations 不可刪除',
  () => deleteDoc(doc(P001(), 'care_relations/rel1__doctor')), 'deny');

// ── 緊急調閱（break-glass）──────────────────────────────────────────────
//
// 這條規則與其他每一條的目的相反：它刻意允許醫師自我授權，
// 因為急診病患無法掛號，而此時最需要知道他在吃什麼藥。
//
// 因此這批測試釘住的不是「能不能存取」，而是**宣告的品質**——
// 理由必須實質填寫、時間由伺服器決定、時效有上限、記錄不可湮滅、
// 身分不可冒名。這些條件若失守，緊急調閱就退化成一個沒有代價的後門。
const bgDoc = (extra) => Object.assign({
  patient: 'nobody', doctor: 'doctor',
  reason: '病患意識不清由救護車送達急診，需確認抗凝血劑使用情形',
  declaredAt: serverTimestamp(),
  expiresAt: Timestamp.fromDate(new Date(Date.now() + 3 * 3600 * 1000))
}, extra || {});

// 合法：填了實質理由、時效在上限內
await run('緊急調閱 醫師宣告後可存取',
  () => setDoc(doc(DOC(), 'break_glass/nobody__doctor'), bgDoc()), 'allow');
await run('緊急調閱 宣告後讀得到原本讀不到的病歷',
  () => getDoc(doc(DOC(), 'patient_data/nobody')), 'allow');

// 理由不可虛應。一鍵取用的後門與沒有後門的差別，全在這個門檻上
await run('緊急調閱 理由過短',
  () => setDoc(doc(DOC(), 'break_glass/rel2__doctor'), bgDoc({ patient: 'rel2', reason: '急診' })), 'deny');
await run('緊急調閱 理由留空',
  () => setDoc(doc(DOC(), 'break_glass/rel2__doctor'), bgDoc({ patient: 'rel2', reason: '' })), 'deny');

// 時效不可自訂為永久——否則一次宣告換來無限期的病歷存取權
await run('緊急調閱 時效超過 4 小時上限',
  () => setDoc(doc(DOC(), 'break_glass/rel2__doctor'), bgDoc({
    patient: 'rel2', expiresAt: Timestamp.fromDate(new Date(Date.now() + 30 * 86400000)) })), 'deny');

// 宣告時間由伺服器決定，不可回填造假時序
await run('緊急調閱 回填宣告時間',
  () => setDoc(doc(DOC(), 'break_glass/rel2__doctor'), bgDoc({
    patient: 'rel2', declaredAt: Timestamp.fromDate(new Date(0)) })), 'deny');

// 不可冒名：把調閱記到別的醫師頭上
await run('緊急調閱 冒用他人身分宣告',
  () => setDoc(doc(DOC(), 'break_glass/rel2__otherdoc'), bgDoc({ patient: 'rel2', doctor: 'otherdoc' })), 'deny');
// 文件 ID 與內容不符時，規則的 O(1) 查找會指向錯誤的宣告
await run('緊急調閱 文件 ID 與內容不符',
  () => setDoc(doc(DOC(), 'break_glass/someoneelse__doctor'), bgDoc({ patient: 'rel2' })), 'deny');

// 病患不可替自己建立（那不是緊急調閱），核保端更不可
await run('緊急調閱 病患自行建立',
  () => setDoc(doc(P001(), 'break_glass/P001__doctor'), bgDoc({ patient: 'P001' })), 'deny');
await run('緊急調閱 核保端建立',
  () => setDoc(doc(INS(), 'break_glass/P001__insurance01'), bgDoc({ patient: 'P001', doctor: 'insurance01' })), 'deny');

// 【最重要】記錄不可湮滅。能被刪除的調閱記錄等於沒有記錄
await run('緊急調閱 宣告者刪除自己的記錄',
  () => deleteDoc(doc(DOC(), 'break_glass/nobody__doctor')), 'deny');
await run('緊急調閱 管理員刪除記錄',
  () => deleteDoc(doc(ADM(), 'break_glass/nobody__doctor')), 'deny');
// 重新宣告是一次全新的宣告，同樣要填理由、同樣重新計時——不是「延長」
await run('緊急調閱 重新宣告需重填理由',
  () => updateDoc(doc(DOC(), 'break_glass/nobody__doctor'), { reason: '短' }), 'deny');
// 病患看得到誰調閱過自己——這是這套機制對病患的意義所在。
// 需先種入一筆：讀不存在的文件時 resource 為 null，各分支皆不成立而被拒，
// 那測到的會是「文件不存在」，不是「病患有沒有讀取權」。
await env.withSecurityRulesDisabled(async ctx => {
  await setDoc(doc(ctx.firestore(), 'break_glass/P001__doctor'), {
    patient: 'P001', doctor: 'doctor', reason: '急診到院，需確認用藥',
    declaredAt: new Date(), expiresAt: Timestamp.fromDate(new Date(Date.now() + 3600000))
  });
});
await run('緊急調閱 病患可查看誰調閱過自己',
  () => getDoc(doc(P001(), 'break_glass/P001__doctor')), 'allow');
await run('緊急調閱 他人不可查看該記錄',
  () => getDoc(doc(ATK(), 'break_glass/P001__doctor')), 'deny');

// ── 身分證字號 ──────────────────────────────────────────────────────────
//
// 病患可填一次、之後不可更改；核驗狀態只有院方能設。
// 這兩件事分開的理由：病患自己輸入的證號是「自述」，
// 與院方核對過健保卡的證號不是同一件事——與 attestedBy 同一種處理。
//
// 允許反覆更改會讓身分可以被重新宣告，而核驗是針對某一個特定號碼做的；
// 號碼一換，核驗就失去意義，畫面上卻仍顯示「已核驗」。
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  // 尚未填寫證號的病患（P001 的 profile 目前沒有 nationalId）
  await setDoc(doc(db, 'patient_data/nid1'), {
    profile: { id: 'nid1', name: '未填證號' }, medications: [], ddiAlerts: [], reminders: [],
    assignedDoctor: 'doctor' });
  await setDoc(doc(db, 'user_roles/uidNid1'), {
    username: 'nid1', name: '未填證號', role: 'patient', status: 'active' });
  // 已填寫證號的病患
  await setDoc(doc(db, 'patient_data/nid2'), {
    profile: { id: 'nid2', name: '已填證號', nationalId: 'A123456789' },
    medications: [], ddiAlerts: [], reminders: [], assignedDoctor: 'doctor' });
  await setDoc(doc(db, 'user_roles/uidNid2'), {
    username: 'nid2', name: '已填證號', role: 'patient', status: 'active' });
  // 另外兩位尚未填號的病患，專用於外來人口統一證號（第 2 碼 8/9）的格式測試——
  // 不可共用 nid1：寫入一次即鎖死（見下方「首次填寫」測試），
  // 再拿同一份 fixture 測 8/9 會撞上寫入次數限制，測到的就不是格式規則本身。
  await setDoc(doc(db, 'patient_data/nid3'), {
    profile: { id: 'nid3', name: '未填證號（外來 8）' }, medications: [], ddiAlerts: [], reminders: [],
    assignedDoctor: 'doctor' });
  await setDoc(doc(db, 'user_roles/uidNid3'), {
    username: 'nid3', name: '未填證號（外來 8）', role: 'patient', status: 'active' });
  await setDoc(doc(db, 'patient_data/nid4'), {
    profile: { id: 'nid4', name: '未填證號（外來 9）' }, medications: [], ddiAlerts: [], reminders: [],
    assignedDoctor: 'doctor' });
  await setDoc(doc(db, 'user_roles/uidNid4'), {
    username: 'nid4', name: '未填證號（外來 9）', role: 'patient', status: 'active' });
});
const NID1 = () => ctxFor('uidNid1', 'nid1@medsafe.local').firestore();
const NID2 = () => ctxFor('uidNid2', 'nid2@medsafe.local').firestore();
const NID3 = () => ctxFor('uidNid3', 'nid3@medsafe.local').firestore();
const NID4 = () => ctxFor('uidNid4', 'nid4@medsafe.local').firestore();

// 首次填寫：格式正確才收
await run('身分證 病患首次填寫（格式正確）',
  () => updateDoc(doc(NID1(), 'patient_data/nid1'),
    { profile: { id: 'nid1', name: '未填證號', nationalId: 'B287654326' } }), 'allow');
await run('身分證 格式錯誤（缺英文字母）',
  () => updateDoc(doc(NID1(), 'patient_data/nid1'),
    { profile: { id: 'nid1', name: '未填證號', nationalId: '1234567890' } }), 'deny');
await run('身分證 格式錯誤（第二碼非 1/2/8/9）',
  () => updateDoc(doc(NID1(), 'patient_data/nid1'),
    { profile: { id: 'nid1', name: '未填證號', nationalId: 'A323456781' } }), 'deny');
await run('身分證 格式錯誤（長度不足）',
  () => updateDoc(doc(NID1(), 'patient_data/nid1'),
    { profile: { id: 'nid1', name: '未填證號', nationalId: 'A12345' } }), 'deny');
// 外來人口統一證號（第 2 碼 8 或 9）：與本國國民共用同一套格式規則，
// 不得被單獨擋下——否則持此證號的病患永遠無法被櫃檯查到（見 js/utils.js 的說明）。
await run('身分證 外來人口統一證號（第二碼 8）格式應通過',
  () => updateDoc(doc(NID3(), 'patient_data/nid3'),
    { profile: { id: 'nid3', name: '未填證號（外來 8）', nationalId: 'A823456783' } }), 'allow');
await run('身分證 外來人口統一證號（第二碼 9）格式應通過',
  () => updateDoc(doc(NID4(), 'patient_data/nid4'),
    { profile: { id: 'nid4', name: '未填證號（外來 9）', nationalId: 'A923456785' } }), 'allow');

// 【核心】填過就不能改——否則核驗狀態會與號碼脫鉤
await run('身分證 病患竄改已填寫的證號',
  () => updateDoc(doc(NID2(), 'patient_data/nid2'),
    { profile: { id: 'nid2', name: '已填證號', nationalId: 'C209876541' } }), 'deny');
// 不影響其他 profile 欄位的正常維護
await run('身分證 保留原證號時可改其他 profile 欄位',
  () => updateDoc(doc(NID2(), 'patient_data/nid2'),
    { profile: { id: 'nid2', name: '改了名字', nationalId: 'A123456789' } }), 'allow');

// 核驗狀態是院方的斷言，病患不得自行宣告
await run('身分證 病患自行宣告已核驗',
  () => updateDoc(doc(NID2(), 'patient_data/nid2'), { nationalIdVerifiedBy: 'doctor' }), 'deny');
await run('身分證 自助註冊時夾帶已核驗欄位',
  () => setDoc(doc(NEW5(), 'patient_data/newbie5b'), {
    profile: { id: 'newbie5b', nationalId: 'A123456789' },
    medications: [], ddiAlerts: [], aiInsights: [], nationalIdVerifiedBy: 'doctor' }), 'deny');
// 建檔時帶的證號同樣要驗格式
await run('身分證 自助註冊帶入格式錯誤的證號',
  () => setDoc(doc(NEW6(), 'patient_data/newbie6b'), {
    profile: { id: 'newbie6b', nationalId: 'bad' },
    medications: [], ddiAlerts: [], aiInsights: [] }), 'deny');

// ── 核驗：一句具名的斷言 ──────────────────────────────────────────────
// 「我核對過這個人的證件，號碼相符」。因此核驗者必須是動作發起人自己，
// 時間由伺服器決定，且必須真的有號碼可核驗。
await run('核驗 醫師具名核驗有證號的病患',
  () => updateDoc(doc(DOC(), 'patient_data/nid2'),
    { nationalIdVerifiedBy: 'doctor', nationalIdVerifiedAt: serverTimestamp() }), 'allow');
await run('核驗 冒用他人名義核驗',
  () => updateDoc(doc(DOC(), 'patient_data/nid2'),
    { nationalIdVerifiedBy: 'otherdoc', nationalIdVerifiedAt: serverTimestamp() }), 'deny');
await run('核驗 回填核驗時間',
  () => updateDoc(doc(DOC(), 'patient_data/nid2'),
    { nationalIdVerifiedBy: 'doctor', nationalIdVerifiedAt: Timestamp.fromDate(new Date(0)) }), 'deny');
// 【回歸測試】核驗過的病患，之後任何不相干的欄位寫入都必須仍然允許。
// 曾經的漏洞：核驗當下 nationalIdVerifiedAt == request.time 成立，
// 但之後任何一次不相干的寫入都會讓這個等式不再成立（nationalIdVerifiedAt
// 是舊值、request.time 是現在）——若沒有「核驗欄位本身未被這次寫入變動」
// 的放行條件，核驗過的病患會變成永久唯讀病歷，連醫師開藥都會被擋下。
await run('核驗 核驗過的病患仍可被寫入不相干欄位（防止變成永久唯讀）',
  () => updateDoc(doc(DOC(), 'patient_data/nid2'),
    { reminders: [{ time: '08:00', text: '服用測試藥', completed: false }] }), 'allow');
// 對一份沒有證號的病歷宣告「已核驗」，那句話沒有指涉對象
await run('核驗 對無證號的病歷宣告已核驗',
  () => updateDoc(doc(DOC(), 'patient_data/P900'),
    { nationalIdVerifiedBy: 'doctor', nationalIdVerifiedAt: serverTimestamp() }), 'deny');
// 發現對不上時必須能立刻收回，門檻不該高於宣告
await run('核驗 可撤銷核驗',
  () => updateDoc(doc(DOC(), 'patient_data/nid2'), { nationalIdVerifiedBy: null }), 'allow');

// 核保端不得經由摘要取得證號——白名單本來就擋住，這條釘住它不被放寬
await run('身分證 核保摘要不得夾帶證號',
  () => setDoc(doc(P001(), 'patient_summaries/P001'), {
    username: 'P001', displayName: '張小泉', ageBand: '65–74 歲', medicationCount: 3,
    alertCount: 0, safetyScore: 92, scoreStatus: 'assessed',
    attestedBy: 'P001', attestedAt: serverTimestamp(), nationalId: 'A123456789' }), 'deny');

// ── 身分證字號索引：可精確查號，不可列舉 ────────────────────────────────
//
// 【這一組是整個「醫護輸入證號指派」設計成立與否的關鍵】
// 精確查號與搜尋病患的差別，完全繫於能不能列舉。
// 若醫師能一次撈出整個索引，它立刻退化成「醫師搜尋全院病患」——
// 也就是先前明確否決的方案，而且外洩的是全院身分證字號對照表。
//
// Firestore 的 read 可細分為 get 與 list，兩者分別授權。
// 只寫 `allow read: if isDoctor()` 會同時允許 list，那正是上述災難。
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'patient_index/B287654326'), { username: 'nid2' });
  await setDoc(doc(db, 'patient_index/C209876541'), { username: 'nid1' });
});

await run('索引 醫師以完整證號精確查詢',
  () => getDoc(doc(DOC(), 'patient_index/B287654326')), 'allow');
// 【核心】這一條若失守，整個設計就變成先前否決的那個方案
await run('索引 醫師列舉整個索引',
  () => getDocs(collection(DOC(), 'patient_index')), 'deny');
await run('索引 管理員列舉整個索引',
  () => getDocs(collection(ADM(), 'patient_index')), 'deny');
await run('索引 核保端查詢證號',
  () => getDoc(doc(INS(), 'patient_index/B287654326')), 'deny');
await run('索引 病患查詢他人證號',
  () => getDoc(doc(P001(), 'patient_index/B287654326')), 'deny');

// 索引鍵必須真的是自己的證號，否則可把他人證號指向自己的帳號，
// 使醫師輸入該號碼時調出錯誤的病歷
await run('索引 病患發布自己的證號索引',
  () => setDoc(doc(NID2(), 'patient_index/A123456789'), { username: 'nid2' }), 'allow');
await run('索引 病患把他人證號指向自己',
  () => setDoc(doc(NID1(), 'patient_index/A123456789'), { username: 'nid1' }), 'deny');
await run('索引 病患替他人發布索引',
  () => setDoc(doc(NID1(), 'patient_index/B287654326'), { username: 'nid2' }), 'deny');
await run('索引 夾帶白名單外欄位',
  () => setDoc(doc(NID2(), 'patient_index/A123456789'), { username: 'nid2', note: 'x' }), 'deny');
await run('索引 醫師不可自行發布索引',
  () => setDoc(doc(DOC(), 'patient_index/D112358131'), { username: 'nid2' }), 'deny');

// ── 醫護持證件建立照護關係（basis: 'id-presented'）──────────────────────
//
// 這是自我授權，與緊急調閱同一種性質，因此必須具名。
// 差別在於這是常規流程，故不要求填寫理由——basis 欄位本身即為說明。
await run('指派 醫師具名建立照護關係',
  () => setDoc(doc(DOC(), 'care_relations/nid2__doctor'), {
    patient: 'nid2', doctor: 'doctor', status: 'active', basis: 'id-presented',
    grantedAt: serverTimestamp(),
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 90 * 86400000)) }), 'allow');
await run('指派 建立後即可讀取該病歷',
  () => getDoc(doc(DOC(), 'patient_data/nid2')), 'allow');

// ── 到期時間上限（本次修復）──────────────────────────────────────────
//
// id-presented 與緊急調閱是同一種「醫師自行宣告即可取得存取權」的語意，
// 但原本只有緊急調閱受 4 小時上限約束，這裡完全沒有上限——對照組實測
// 曾證實醫師可自行建立 10 年期關係並隨即讀到完整病歷。用一個獨立於
// nid2 的病患名（nidcap）測試，避免影響上面 nid2 既有的關係狀態。
await run('指派 到期時間超過 91 天上限（id-presented，建立）',
  () => setDoc(doc(DOC(), 'care_relations/nidcap__doctor'), {
    patient: 'nidcap', doctor: 'doctor', status: 'active', basis: 'id-presented',
    grantedAt: serverTimestamp(),
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 365 * 86400000)) }), 'deny');
await run('指派 到期時間在 91 天上限內可正常建立（id-presented）',
  () => setDoc(doc(DOC(), 'care_relations/nidcap__doctor'), {
    patient: 'nidcap', doctor: 'doctor', status: 'active', basis: 'id-presented',
    grantedAt: serverTimestamp(),
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 90 * 86400000)) }), 'allow');
// 續期／重新報到同樣受上限約束，否則「先建立在上限內、再用 update 續到很久以後」
// 就成了繞過上限的後門
await run('指派 續期延到超過上限同樣被拒（update）',
  () => updateDoc(doc(DOC(), 'care_relations/nidcap__doctor'), {
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 365 * 86400000)) }), 'deny');
// 只改 status（撤銷）不涉及 expiresAt，不受本次上限檢查影響
await run('指派 只改 status 不受到期上限檢查影響',
  () => updateDoc(doc(DOC(), 'care_relations/nidcap__doctor'), { status: 'revoked' }), 'allow');
// 病患本人授予（basis: 'patient'）走的是同一個 create 規則，上限同樣適用——
// 不是只挑 id-presented 這條路徑收斂，而是整個集合都不該有「永久授權」
await run('指派 病患自行授予時到期時間同樣受上限約束',
  () => setDoc(doc(NID1(), 'care_relations/nid1__otherdoc2'), {
    patient: 'nid1', doctor: 'otherdoc2', status: 'active',
    grantedAt: serverTimestamp(),
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 365 * 86400000)) }), 'deny');

// 【本次修復的迴歸測試】上面的 care_relations 已經授予成功，但 appointments
// 的 create 規則原本只認得「病患本人掛號」這一條路徑。confirmAssign() 在
// 授予關係後緊接著建立一筆掛號紀錄（清單來源），這筆寫入原本會被拒絕——
// 醫師讀得到病歷，卻不會出現在「進行中」清單上，F5 後就像這位病患消失了。
await run('指派 醫師報到後建立掛號紀錄（清單來源）',
  () => setDoc(doc(DOC(), 'appointments/apt-nid2'), apptDoc({
    patient: 'nid2', patientName: 'nid2', note: '櫃檯報到（持證件）' })), 'allow');
// 沒有先建立照護關係就不能無中生有一筆掛號，否則醫師能替任意病患
// 捏造一次不曾發生的診療
await run('指派 醫師對無照護關係的病患建立掛號紀錄',
  () => setDoc(doc(DOC(), 'appointments/apt-nid1'), apptDoc({
    patient: 'nid1', patientName: 'nid1', note: '櫃檯報到（持證件）' })), 'deny');

// 報到後醫師同樣要能開啟與這位病患的對話（同一個 resource == null 判斷讀取），
// 但僅限於已有進行中照護關係的病患——不是任意病患
await run('指派 醫師讀有照護關係病患尚不存在的對話',
  () => getDoc(doc(DOC(), 'conversations/nid2')), 'allow');
await run('指派 醫師讀無照護關係病患尚不存在的對話',
  () => getDoc(doc(DOC(), 'conversations/nid1')), 'deny');

// 少了 basis 就無從分辨這份授權是誰給的
await run('指派 醫師建立但未標示 basis',
  () => setDoc(doc(DOC(), 'care_relations/nid1__doctor'), {
    patient: 'nid1', doctor: 'doctor', status: 'active',
    grantedAt: serverTimestamp(),
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 86400000)) }), 'deny');
await run('指派 醫師冒用他人名義建立',
  () => setDoc(doc(DOC(), 'care_relations/nid1__otherdoc'), {
    patient: 'nid1', doctor: 'otherdoc', status: 'active', basis: 'id-presented',
    grantedAt: serverTimestamp(),
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 86400000)) }), 'deny');
// 【不可退讓】病患對醫護建立的關係必須保有撤銷權，
// 否則這條路徑就成了病患無法收回的單方面授權
await run('指派 病患可撤銷醫護建立的關係',
  () => updateDoc(doc(NID2(), 'care_relations/nid2__doctor'), { status: 'revoked' }), 'allow');

// ── LINE 綁定的四個集合 ───────────────────────────────────────────────
//
// 這四個集合在規則層對前端幾乎全關，唯一開放的是「病患讀自己的綁定狀態」。
// 因此本節測的重點不是「誰可以做什麼」，而是「關的地方真的關上了」——
// 尤其是 line_users：它是 LIFF 換發 Custom Token 的依據，
// 一旦可讀可寫，等於任何人都能把自己的 LINE 指向別人的帳號。
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'line_bindings/P001'), {
    uid: 'uidP001', username: 'P001', lineUserId: 'Uline0001', active: true, linkedAt: new Date() });
  await setDoc(doc(db, 'line_users/Uline0001'), { username: 'P001', uid: 'uidP001' });
  await setDoc(doc(db, 'line_link_codes/AAAA2345'), {
    username: 'P001', uid: 'uidP001', used: false,
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 600000)) });
  await setDoc(doc(db, 'line_push_log/P001__2026-09-09__daily'), { at: new Date() });
});

// 唯一開放的路徑：病患看得到自己綁了沒（前端要據此顯示「已綁定 / 尚未綁定」）
await run('LINE 病患讀自己的綁定狀態',
  () => getDoc(doc(P001(), 'line_bindings/P001')), 'allow');
await run('LINE 他人讀別人的綁定狀態',
  () => getDoc(doc(ATK(), 'line_bindings/P001')), 'deny');
// 縱深防禦：uidForged 的 user_roles 自稱 username 是 P001，
// 但它的 token.email 是 forged@medsafe.local——isOwnUsername 的第二道檢查要擋下它
await run('LINE 偽造身分索引讀他人綁定狀態',
  () => getDoc(doc(FORGED(), 'line_bindings/P001')), 'deny');

// 【不可退讓】能自己寫 line_bindings，就能把任意 lineUserId 宣稱成自己的，
// 之後這位病患的所有用藥提醒都會被推到攻擊者的手機上
await run('LINE 病患不可自行寫入綁定',
  () => setDoc(doc(P001(), 'line_bindings/P001'), {
    uid: 'uidP001', username: 'P001', lineUserId: 'Uattacker', active: true }), 'deny');
await run('LINE 病患不可竄改自己的綁定',
  () => updateDoc(doc(P001(), 'line_bindings/P001'), { lineUserId: 'Uattacker' }), 'deny');
await run('LINE admin 亦不可寫入綁定',
  () => updateDoc(doc(ADM(), 'line_bindings/P001'), { active: false }), 'deny');

// 【不可退讓】line_users 是 lineUserId → uid 的換發依據。
// 可讀 = 由 LINE 帳號反查得出病患身分；可寫 = 直接接管帳號。
await run('LINE 反向索引不可讀（本人也不行）',
  () => getDoc(doc(P001(), 'line_users/Uline0001')), 'deny');
await run('LINE 反向索引不可列舉',
  () => getDocs(collection(P001(), 'line_users')), 'deny');
await run('LINE 反向索引不可寫',
  () => setDoc(doc(ATK(), 'line_users/Uattacker'), { username: 'P001', uid: 'uidP001' }), 'deny');
await run('LINE admin 亦不可讀反向索引',
  () => getDoc(doc(ADM(), 'line_users/Uline0001')), 'deny');

// 綁定碼：由 Function 產生與核銷。前端讀得到別人的碼就是一個可枚舉的授權漏洞；
// 前端寫得出碼，就能把 uid 欄位填成別人的（原設計的帳號接管路徑，見規則註解）
await run('LINE 綁定碼不可讀',
  () => getDoc(doc(P001(), 'line_link_codes/AAAA2345')), 'deny');
await run('LINE 綁定碼不可列舉',
  () => getDocs(collection(P001(), 'line_link_codes')), 'deny');
await run('LINE 病患不可自行建立綁定碼',
  () => setDoc(doc(P001(), 'line_link_codes/BBBB2345'), {
    username: 'P001', uid: 'uidP001', used: false,
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 600000)) }), 'deny');
// 這一條是原設計漏洞的直接迴歸測試：碼裡的 uid 指向他人時亦不得寫入
await run('LINE 病患不可建立指向他人 uid 的綁定碼',
  () => setDoc(doc(P001(), 'line_link_codes/CCCC2345'), {
    username: 'P001', uid: 'uidAtk', used: false,
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 600000)) }), 'deny');
await run('LINE 病患不可核銷綁定碼',
  () => updateDoc(doc(P001(), 'line_link_codes/AAAA2345'), { used: true }), 'deny');

// 推播冪等鎖：純內部狀態。可寫 = 可以讓某位病患整天收不到提醒
await run('LINE 推播記錄不可讀',
  () => getDoc(doc(P001(), 'line_push_log/P001__2026-09-09__daily')), 'deny');
await run('LINE 推播記錄不可寫（可用於封鎖他人的提醒）',
  () => setDoc(doc(ATK(), 'line_push_log/P001__2026-09-10__daily'), { at: new Date() }), 'deny');

console.log('');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '\n      ' + r[2] : '');
const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
await env.cleanup();
process.exit(failed.length ? 1 : 0);
