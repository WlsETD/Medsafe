// 交互作用偵測引擎的迴歸測試（Phase 3）。
//
// 這份測試守的是系統最核心的賣點。它刻意包含幾條「會失敗才對」的斷言：
// 引擎必須在查不到規則時說「不知道」，而不是說「安全」。
//
// 關於驗收標準的偏離（誠實說明）：
// 稽核報告的 Phase 3 驗收標準寫的是「挑選至少 20 組已知會產生交互作用的藥物組合實際測試」。
// 但本系統的藥物目錄僅 9 種藥，兩兩組合上限為 C(9,2) = 36 組，其中有實證記載的
// 交互作用只有 5 組——湊不出 20 組「已知會產生交互作用」的組合。
// 硬湊的唯一方法是編造交互作用，那正是這份稽核報告從頭到尾在反對的事。
// 因此改為【窮舉全部 36 組】並逐一斷言預期結果，涵蓋率為 100%，強於抽測 20 組。
// 待藥物目錄擴充後，本檔的 EXPECTED 表需同步擴充。
//
// 執行：node tests/ddi-engine.test.mjs（不需要 Firestore 模擬器）

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

global.window = {};
require('../js/drug-catalog.js');
require('../js/ddi-engine.js');
require('../js/mockData.js');
const C = global.window.DrugCatalog;
const E = global.window.DdiEngine;
const mock = global.window.mockData;

const results = [];
const check = (name, cond, detail) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (detail || '')]);

// 本地規則庫 = 內建規則 + 關係圖連線（與 dashboard 的合併方式一致）
const LOCAL_RULES = (mock.ddiRules || []).concat(mock.graphData.links || []);

// ---------------------------------------------------------------
// 一、窮舉全部兩兩組合
// ---------------------------------------------------------------
// 有實證記載的組合。未列於此表者一律預期「知識庫未收錄」。
// 每一條的臨床依據與出處記於 js/mockData.js 的 ddiRules。
const EXPECTED = {
  'B01AA03|B01AC06': 'major',      // Warfarin × Aspirin：出血風險相加
  'B01AA03|C01BD01': 'major',      // Warfarin × Amiodarone：CYP2C9 抑制，INR 上升
  'C01BD01|C10AA05': 'moderate',   // Amiodarone × Atorvastatin：CYP3A4 抑制，肌肉毒性
  'A10BA02|V08A':    'moderate',   // Metformin × 含碘顯影劑：腎損傷時乳酸中毒
  'A11A|B01AA03':    'minor'       // Warfarin × 綜合維他命：維生素 K 拮抗
};

const ALL = C.all().map(d => d.atc);
const pairKey = (a, b) => [a, b].sort().join('|');
let pairCount = 0;
const wrongPairs = [];
for (let i = 0; i < ALL.length; i++) {
  for (let j = i + 1; j < ALL.length; j++) {
    pairCount++;
    const a = ALL[i], b = ALL[j];
    const r = E.analyze([{ atc: a }, { atc: b }], LOCAL_RULES);
    const expected = EXPECTED[pairKey(a, b)] || null;
    const actual = r.findings.length ? r.findings[0].severity : null;
    if (actual !== expected) {
      wrongPairs.push(pairKey(a, b) + ' 預期 ' + (expected || '無') + '，實得 ' + (actual || '無'));
    }
  }
}
check('窮舉全部 ' + pairCount + ' 組兩兩配對，結果與實證對照表一致',
      wrongPairs.length === 0, wrongPairs.join('\n        '));
check('配對總數為 C(9,2) = 36（目錄擴充後此數需同步更新）', pairCount === 36,
      '實際為 ' + pairCount + '，表示目錄藥物數已變動，EXPECTED 表需複核');

// ---------------------------------------------------------------
// 二、跨院藥名寫法必須命中同一條規則（P1-10 的實際效益）
// ---------------------------------------------------------------
// 這是 Phase 2 的投資在 Phase 3 兌現的地方：修復前引擎以 name_en 字串比對，
// 「Warfarin Sodium」與「Warfarin」比不到一起，這組重大交互作用會直接漏判。
const CROSS = [
  [['Warfarin Sodium', '阿司匹林'], 'major', '英文鹽類形式 × 大陸中文譯名'],
  [['可邁丁', 'ASA'], 'major', '台灣商品名 × 英文縮寫'],
  [['warfarin sodium 5mg 錠', 'aspirin 100mg'], 'major', '帶劑量與劑型的完整字串'],
  [['Cordarone', 'Lipitor'], 'moderate', '兩者皆為國際商品名'],
  [['二甲雙胍', '顯影劑'], 'moderate', '兩者皆為中文名']
];
for (const [names, expected, label] of CROSS) {
  const r = E.analyze(names.map(n => ({ name_en: n })), LOCAL_RULES);
  const got = r.findings.length ? r.findings[0].severity : null;
  check('跨院寫法命中規則：' + names.join(' + ') + '（' + label + '）',
        got === expected, '預期 ' + expected + '，實得 ' + (got || '無'));
}

// ---------------------------------------------------------------
// 三、【本階段最重要】現有用藥彼此之間必須被檢查
// ---------------------------------------------------------------
// 修復前的引擎只比對「新開的藥 vs 現有藥」。示範病患 P004 目前同時服用
// Warfarin、Aspirin、Amiodarone，其中有兩組重大交互作用已經存在，
// 但除非醫師剛好要開第四種藥，系統從頭到尾不會提起。
const p004 = (mock.patients.P004.medications || []);
const rP004 = E.analyze(p004, LOCAL_RULES);
check('P004 現有用藥在「未開新藥」的情況下即偵測到交互作用',
      rP004.findings.length >= 2,
      '僅偵測到 ' + rP004.findings.length + ' 組；預期至少 2 組（Warfarin×Aspirin、Warfarin×Amiodarone）');
check('P004 偵測到的兩組皆為 major',
      rP004.findings.filter(f => f.severity === 'major').length >= 2);
check('P004 的整體結論為 risk', rP004.verdict === 'risk');
check('P004 檢查的配對數為 C(4,2) = 6', rP004.pairsChecked === 6,
      '實際 ' + rP004.pairsChecked);

// 三種藥的組合中，交互作用可能不涉及新開的藥。這組測試確保這種情況不被漏掉。
const rExisting = E.analyze(
  [{ atc: 'B01AA03' }, { atc: 'C01BD01' }, { atc: 'A11CC05' }], LOCAL_RULES);
check('交互作用發生在兩個「現有藥」之間時仍被偵測（新藥無關亦然）',
      rExisting.findings.length === 1 && rExisting.findings[0].severity === 'major');

// ---------------------------------------------------------------
// 四、無從得知不可呈現為安全（P0-3、P1-12）
// ---------------------------------------------------------------
const rMulti = E.analyze([{ atc: 'A11A' }, { atc: 'C09AA03' }], LOCAL_RULES);
check('綜合維他命 × 賴諾普利：查無規則，但結論為 unevaluable 而非 no-known-interaction',
      rMulti.verdict === 'unevaluable' && rMulti.findings.length === 0);
check('綜合維他命被列入 unevaluable 且理由為 composition',
      rMulti.unevaluable.length === 1 && rMulti.unevaluable[0].kind === 'composition');
check('unevaluable 的理由文字非空且提及向藥師確認',
      rMulti.unevaluable[0].reason.includes('藥師'));

const rUnknown = E.analyze([{ name_en: 'Ibuprofen' }, { atc: 'B01AA03' }], LOCAL_RULES);
check('系統不認得的藥：結論為 unevaluable，不可呈現為未發現交互作用',
      rUnknown.verdict === 'unevaluable');
check('不認得的藥被列入 unevaluable 且理由為 unknown-drug',
      rUnknown.unevaluable.length === 1 && rUnknown.unevaluable[0].kind === 'unknown-drug');
check('不認得的藥不計入已比對的配對數（不可讓涵蓋率虛胖）',
      rUnknown.pairsChecked === 0, '實際 ' + rUnknown.pairsChecked);

// 既有交互作用 + 成分不明的藥同時存在時，兩者都要回報，不可互相掩蓋
const rBoth = E.analyze([{ atc: 'B01AA03' }, { atc: 'B01AC06' }, { atc: 'A11A' }], LOCAL_RULES);
check('同時有已知交互作用與無法評估的藥時，兩者皆回報',
      rBoth.verdict === 'risk' && rBoth.findings.length >= 1 && rBoth.unevaluable.length === 1);

// 全部為單一成分且查無規則時，才可回報「知識庫未收錄」
const rClean = E.analyze([{ atc: 'C09AA03' }, { atc: 'A11CC05' }], LOCAL_RULES);
check('全為成分明確的藥且查無規則時，結論為 no-known-interaction',
      rClean.verdict === 'no-known-interaction' && rClean.unevaluable.length === 0);

// ---------------------------------------------------------------
// 五、ATC 階層比對
// ---------------------------------------------------------------
// 寫在類別碼 V08A 上的規則，必須命中其下的任一具體成分（例如碘海醇 V08AB02），
// 否則每新增一個顯影劑成分就要重寫規則，漏寫的那個就是下一次漏判。
check('類別碼規則命中其下的具體成分（V08A 規則 → V08AB02 藥物）',
      E.atcMatches('V08A', 'V08AB02') === true);
check('反向不成立：具體成分的規則不得命中類別碼（超出已知範圍的推論）',
      E.atcMatches('V08AB02', 'V08A') === false);
check('不同類別互不命中', E.atcMatches('V08A', 'B01AA03') === false);

// ---------------------------------------------------------------
// 六、嚴重度分級
// ---------------------------------------------------------------
// 字串比大小會得到字典序（'major' < 'minor'），是這類程式常見的錯誤來源。
check('嚴重度以數值排序，major 高於 minor',
      E.SEVERITY.major.rank > E.SEVERITY.minor.rank);
check('嚴重度以數值排序，contraindicated 最高',
      E.SEVERITY.contraindicated.rank > E.SEVERITY.major.rank);

const rSort = E.analyze(
  [{ atc: 'B01AA03' }, { atc: 'A11A' }, { atc: 'B01AC06' }], LOCAL_RULES);
check('多筆結果依嚴重度由高至低排序',
      rSort.findings.length >= 2 && rSort.findings[0].severityRank >= rSort.findings[rSort.findings.length - 1].severityRank);
check('topSeverity 取最嚴重者而非第一筆', rSort.topSeverity === 'major');

// 中文嚴重度字串（舊資料與雲端規則可能使用）須能正規化
check('中文嚴重度「極高風險」正規化為 major', E.normalizeSeverity('極高風險') === 'major');
check('中文嚴重度「高風險」正規化為 major', E.normalizeSeverity('高風險') === 'major');
check('無法辨識的嚴重度回傳 null（由呼叫端決定如何處理）',
      E.normalizeSeverity('莫名其妙') === null);

// 分級對不上時，規則本身不可被丟棄——丟棄會讓一條真實的交互作用消失
const rWeird = E.analyze([{ atc: 'C09AA03' }, { atc: 'A11CC05' }],
  [{ atcA: 'C09AA03', atcB: 'A11CC05', severity: '莫名其妙', effect: '測試用' }]);
check('嚴重度無法辨識的規則仍會命中，並標記 severityUnknown',
      rWeird.findings.length === 1 && rWeird.findings[0].severityUnknown === true);

// ---------------------------------------------------------------
// 七、規則正規化
// ---------------------------------------------------------------
// graphData.links 用 source/target，ddi_rules 用 drugA/drugB，兩種形狀都要吃得下
const nLinks = E.normalizeRules(mock.graphData.links || []);
check('關係圖連線（source/target 形狀）可被正規化',
      nLinks.rules.length === (mock.graphData.links || []).length);
const nRules = E.normalizeRules(mock.ddiRules || []);
check('內建規則（drugA/drugB 形狀）可被正規化',
      nRules.rules.length === (mock.ddiRules || []).length);

// 本地與雲端重複收錄同一組時只算一次，避免 ruleCount 虛胖
const nDup = E.normalizeRules([
  { atcA: 'B01AA03', atcB: 'B01AC06', severity: 'major' },
  { drugA: 'Warfarin', drugB: 'Aspirin', severity: 'major' }
]);
check('重複的規則只計一次（本地與雲端可能收錄同一組）', nDup.rules.length === 1);

// 兩端解析不到 ATC 的規則必須被丟棄並回報，不可讓它虛增知識庫規模
const nBad = E.normalizeRules([{ drugA: '不存在的藥', drugB: '也不存在', severity: 'major' }]);
check('無法解析為 ATC 的規則被丟棄', nBad.rules.length === 0);
check('被丟棄的規則有回報，不可靜默消失', nBad.dropped.length === 1);

// 規則以藥名（非 ATC）撰寫時，仍須能解析——雲端規則庫多為人工輸入
const nByName = E.normalizeRules([{ drugA: '可邁丁', drugB: '阿斯匹靈', severity: 'major' }]);
check('僅以藥名撰寫的規則可解析為 ATC',
      nByName.rules.length === 1 && nByName.rules[0].atcA && nByName.rules[0].atcB);

// ---------------------------------------------------------------
// 八、規則庫的可稽核性
// ---------------------------------------------------------------
// Metformin × 顯影劑那條規則的內容曾隨 ACR 指引改版而過時，
// 證明臨床規則會變、且變了不會有人通知你。沒有出處的規則無從複核。
const noSource = (mock.ddiRules || []).filter(r => !r.source);
check('每條內建規則都標註出處（可稽核性）', noSource.length === 0,
      '缺出處：' + noSource.map(r => r.drugA + '×' + r.drugB).join(', '));
const noReview = (mock.ddiRules || []).filter(r => !r.reviewedOn);
check('每條內建規則都標註複核日期', noReview.length === 0,
      '缺複核日期：' + noReview.map(r => r.drugA + '×' + r.drugB).join(', '));
const noRec = (mock.ddiRules || []).filter(r => !r.recommendation);
check('每條內建規則都有臨床處置建議（僅說有風險而不說怎麼辦，等於把問題丟回給醫師）',
      noRec.length === 0, '缺建議：' + noRec.map(r => r.drugA + '×' + r.drugB).join(', '));

// 已修正的規則不可再出現「需停藥」這種無條件指示——
// ACR 現行指引為 eGFR ≥30 不需停藥，無條件停藥本身即造成傷害（高血糖）。
const metRule = (mock.ddiRules || []).find(r => r.atcA === 'A10BA02' && r.atcB === 'V08A');
check('Metformin × 顯影劑的建議已依 ACR 現行指引改為依腎功能分流',
      !!metRule && metRule.recommendation.includes('eGFR') && metRule.recommendation.includes('30'));

// ---------------------------------------------------------------
// 九、輸入的容錯
// ---------------------------------------------------------------
for (const [label, input] of [['null', null], ['空陣列', []], ['只有一種藥', [{ atc: 'B01AA03' }]]]) {
  const r = E.analyze(input, LOCAL_RULES);
  check('輸入為' + label + '時不拋錯且結論不為 risk',
        r && r.verdict !== 'risk' && r.findings.length === 0);
}
const rNoRules = E.analyze([{ atc: 'B01AA03' }, { atc: 'B01AC06' }], []);
check('規則庫為空時結論為 no-known-interaction 而非 risk（且 ruleCount 為 0 可供 UI 示警）',
      rNoRules.verdict === 'no-known-interaction' && rNoRules.ruleCount === 0);

// --- 輸出 ---
console.log('');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '\n      ' + r[2] : '');
const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
