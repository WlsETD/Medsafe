// 藥物身分解析的迴歸測試（Phase 2）。
//
// 這份測試守的是「跨院用藥衝突預警」的地基：同一種藥不論以哪個醫院的寫法傳來，
// 都必須歸戶到同一個 ATC 碼。地基一鬆，上層的規則庫再大也比對不到。
//
// 執行：node tests/drug-catalog.test.mjs（不需要 Firestore 模擬器）

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

global.window = {};
require('../js/drug-catalog.js');
require('../js/mockData.js');
const C = global.window.DrugCatalog;
const mock = global.window.mockData;

const results = [];
const check = (name, cond, detail) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (detail || '')]);

// --- 一、跨院藥名解析 ---
// 每一組裡的所有寫法都必須解析到同一個 ATC 碼。這些寫法涵蓋：
// 學名、大小寫差異、鹽類形式、國際商品名、中文譯名（含常見變體）、含劑量與劑型的字串。
const NAME_GROUPS = {
  B01AA03: ['Warfarin', 'warfarin', 'WARFARIN', 'Warfarin Sodium', 'warfarin sodium 5mg',
            'Coumadin', '可邁丁', '華法林', '華法令', 'Warfarin 5mg 錠'],
  B01AC06: ['Aspirin', 'aspirin 100mg', 'Acetylsalicylic Acid', 'ASA',
            '阿斯匹靈', '阿司匹林', '阿斯匹林', '阿司匹靈', 'N02BA01', 'B01AC06'],
  C01BD01: ['Amiodarone', 'Amiodarone HCl', 'Cordarone', '胺碘酮', 'amiodarone hydrochloride 200mg'],
  A10BA02: ['Metformin', 'Metformin HCl', 'Glucophage', '二甲雙胍', 'metformin 500mg 膜衣錠', '甲福明'],
  C09AA03: ['Lisinopril', 'Zestril', 'Prinivil', '賴諾普利', 'lisinopril 10 mg tablet'],
  C10AA05: ['Atorvastatin', 'Atorvastatin Calcium', 'Lipitor', '立普妥', '阿托伐他汀',
            'atorvastatin 20mg film coated tablet']
};
for (const [atc, names] of Object.entries(NAME_GROUPS)) {
  const bad = names.filter(n => { const d = C.resolve(n); return !d || d.atc !== atc; });
  check('跨院寫法皆解析為 ' + atc + '（' + names.length + ' 種寫法）', bad.length === 0,
        '未解析或解析錯誤：' + bad.join(', '));
}

// aspirin 的兩個 ATC 碼必須指向同一種藥。若這條失敗，跨院比對會把
// 「A 院的 B01AC06」與「B 院的 N02BA01」當成兩種不同的藥，交互作用即漏判。
check('同成分不同適應症的 ATC 碼歸戶為同一藥（B01AC06 = N02BA01）',
      C.byAtc('B01AC06') === C.byAtc('N02BA01') && C.byAtc('N02BA01') !== null);

// --- 二、查不到必須回傳 null，不可猜測 ---
// 這是 P0-3「查無資料就顯示安全」在藥物解析層的對應。系統「不認得」與
// 系統「確認無交互作用」是完全不同的兩件事，不可在此處就把前者變成後者。
for (const v of ['Ibuprofen', 'Warfarinx', '不存在的藥', '', '   ', null, undefined, 123, {}]) {
  check('未知輸入回傳 null：' + JSON.stringify(v), C.resolve(v) === null);
}

// --- 三、跨語言、跨寫法的同藥判定 ---
const SAME = [
  ['warfarin sodium', '可邁丁', true],
  ['Aspirin', '阿司匹靈', true],
  ['Lipitor', 'Atorvastatin Calcium', true],
  ['Metformin HCl', '二甲雙胍', true],
  ['Warfarin', 'Aspirin', false],
  ['Unknown', 'Warfarin', false],
  ['Unknown', 'AlsoUnknown', false]   // 兩個都不認得時不可回 true
];
for (const [a, b, expect] of SAME) {
  check('sameDrug(' + JSON.stringify(a) + ', ' + JSON.stringify(b) + ') === ' + expect,
        C.sameDrug(a, b) === expect);
}

// --- 四、目錄自身的完整性 ---
const all = C.all();
check('目錄非空', all.length > 0);
// ATC 的碼長依層級而定：第 5 層（單一成分）為 7 碼如 B01AA03；
// 第 3、4 層（治療／化學子群）較短，如 V08A、A11A。兩者都是官方定義的合法 ATC 碼，
// 因此格式檢查必須依 kind 分別驗證，不能用單一樣式套住全部。
//
// 註：此處驗的是 WHO ATC 碼，不是健保藥品代碼。健保碼為 10 碼
//（許可證字號 7 碼 + 劑型碼 1 碼 + 規格碼 2 碼），識別的是「特定廠牌的特定包裝規格」，
// 一種成分會對應數十至數百組健保碼，粒度過細，不適合當交互作用的比對鍵。
const SUBSTANCE_ATC = /^[A-Z]\d{2}[A-Z]{2}\d{2}$/;   // 第 5 層：完整成分碼
const GROUP_ATC = /^[A-Z]\d{2}[A-Z]{0,2}\d{0,2}$/;   // 第 3～4 層：類別碼
const badFormat = all.filter(d => !(d.kind === 'group' ? GROUP_ATC : SUBSTANCE_ATC).test(d.atc));
check('每種藥的 ATC 碼格式符合其層級，且中英文名與分類齊備',
      badFormat.length === 0 && all.every(d => d.name_en && d.name_zh && d.class_zh),
      '格式不合：' + badFormat.map(d => d.atc + '(' + d.kind + ')').join(','));

// 成分碼一律 7 碼、類別碼一律標為 group。兩者不可混淆——
// 劑量檢核與重複用藥偵測只適用於成分，套在類別碼上會得到無意義的結果。
check('kind 標示與碼長一致',
      all.every(d => d.kind === 'group' ? !SUBSTANCE_ATC.test(d.atc) : SUBSTANCE_ATC.test(d.atc)));

// 成分不明的複方不得被判定為安全。這條守的是一個真實存在的致命組合：
// 示範病患同時服用 Warfarin 與綜合維他命，而綜合維他命常含維生素 K（warfarin 的拮抗劑），
// 但 A11A 這個碼不記載配方。查無規則的真正含意是「無從得知」，不是「確認無虞」。
check('綜合維他命不可被判定為安全（含維生素 K 會拮抗 warfarin）',
      C.canBeClearedAsSafe('A11A') === false && C.unclearableReason('A11A').length > 0);
check('單一成分可被正常判定為可評估', C.canBeClearedAsSafe('B01AA03') === true);
check('不認得的藥同樣不可判定為安全', C.canBeClearedAsSafe('ZZZZZZZ') === false);
check('ATC 碼互不重複', new Set(all.map(d => d.atc)).size === all.length);
check('subgroup() 取 ATC 前 5 碼', all.every(d => C.subgroup(d.atc) === d.atc.slice(0, 5)));

// --- 五、與實際資料的一致性（Phase 2 的驗收標準）---
// 「任一藥物無論出現在哪個病患的用藥清單、哪個頁面，都能用同一個代碼互相查詢與比對」。
// 這一節把該標準變成可執行的斷言：掃過系統中每一處藥物參照，
// 全部都必須解析得到，且解析結果要與該筆資料自己標記的 ATC 一致。
const unresolved = [];
const mismatched = [];
const noteRef = (label, name, declaredAtc) => {
  const d = C.resolve(name);
  if (!d) { unresolved.push(label + ': ' + JSON.stringify(name)); return; }
  if (declaredAtc && d.atc !== declaredAtc) {
    mismatched.push(label + ': ' + name + ' 標記為 ' + declaredAtc + '，實際解析為 ' + d.atc);
  }
};

for (const [pid, p] of Object.entries(mock.patients || {})) {
  for (const med of (p.medications || [])) noteRef('patients.' + pid, med.name_en || med.name, med.atc);
}
for (const m of (mock.allMedications || [])) noteRef('allMedications', m.name_en || m.name, m.atc);
for (const n of ((mock.graphData || {}).nodes || [])) noteRef('graphData.nodes', n.name_en || n.id, n.atc);
for (const r of (mock.ddiRules || [])) {
  noteRef('ddiRules.drugA', r.drugA, r.atcA);
  noteRef('ddiRules.drugB', r.drugB, r.atcB);
}

check('系統中每一處藥物參照都解析得到', unresolved.length === 0,
      '無法解析（共 ' + unresolved.length + ' 處）：\n        ' + unresolved.join('\n        '));
check('資料自帶的 atc 欄位與解析結果一致', mismatched.length === 0,
      mismatched.join('\n        '));

// 同一種藥在不同病患的用藥清單中，識別碼必須相同——這是 P1-10 的核心。
const idsByAtc = new Map();
for (const [pid, p] of Object.entries(mock.patients || {})) {
  for (const med of (p.medications || [])) {
    const d = C.resolve(med.name_en || med.name);
    if (!d) continue;
    if (!idsByAtc.has(d.atc)) idsByAtc.set(d.atc, new Set());
    idsByAtc.get(d.atc).add(String(med.atc));
  }
}
const inconsistent = [...idsByAtc.entries()].filter(([, ids]) => ids.size > 1);
check('同一種藥在所有病患清單中使用相同 ATC 碼（P1-10）', inconsistent.length === 0,
      inconsistent.map(([atc, ids]) => atc + ' 出現多組 id：' + [...ids].join(', ')).join('; '));

// 反過來：同一個識別碼不可以指到不同的藥。
const atcById = new Map();
for (const [pid, p] of Object.entries(mock.patients || {})) {
  for (const med of (p.medications || [])) {
    const d = C.resolve(med.name_en || med.name);
    if (!d) continue;
    const key = String(med.atc);
    if (!atcById.has(key)) atcById.set(key, new Set());
    atcById.get(key).add(d.atc);
  }
}
const collided = [...atcById.entries()].filter(([, atcs]) => atcs.size > 1);
check('同一個 ATC 碼不會指到不同的藥（P1-10）', collided.length === 0,
      collided.map(([id, atcs]) => 'id=' + id + ' 同時代表 ' + [...atcs].join(' 與 ')).join('; '));

// --- 輸出 ---
console.log('');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '\n      ' + r[2] : '');
const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
