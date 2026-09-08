// 交互作用偵測引擎的迴歸測試（Phase 3）。
//
// 這份測試守的是系統最核心的賣點。它刻意包含幾條「會失敗才對」的斷言：
// 引擎必須在查不到規則時說「不知道」，而不是說「安全」。
//
// 關於驗收標準的偏離（誠實說明）：
// 稽核報告的 Phase 3 驗收標準寫的是「挑選至少 20 組已知會產生交互作用的藥物組合實際測試」。
// 撰寫當時目錄僅 9 種藥，兩兩組合上限為 C(9,2) = 36 組，其中有實證記載的
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
  'A11A|B01AA03':    'minor',      // Warfarin × 綜合維他命：維生素 K 拮抗
  // 2026-09-08：保健食品／食物層新增（見 js/mockData.js 的三條新規則）。
  // pairKey 依字串排序，'C' 開頭的成分碼排在 'NOATC-' 之前。
  'C10AA05|NOATC-GRAPEFRUIT':     'major',    // Atorvastatin × 葡萄柚：CYP3A4 抑制，肌肉毒性
  'C01BD01|NOATC-GRAPEFRUIT':     'moderate', // Amiodarone × 葡萄柚：CYP3A4 抑制
  'C10AA05|NOATC-REDYEASTRICE':   'major'     // Atorvastatin × 紅麴：monacolin K 即 lovastatin，等同疊加 statin
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
// 2026-09-02：目錄由 9 種擴充為 26 種，C(26,2) = 325。
// 2026-09-03：再擴充為 60 種（DDInter 涵蓋率由 0.10% 提升至 0.67%），C(60,2) = 1770。
// 這條斷言的用途就是在目錄變動時失敗，強迫回頭複核 EXPECTED 表——它已做到三次。
// 2026-09-08：擴充為 70 種——新增 10 項保健食品／食物（NOATC- 開頭，
// 見 js/drug-catalog.js），C(70,2) = 2415。複核結果：新增的 10 項中，
// 葡萄柚×Atorvastatin／葡萄柚×Amiodarone／紅麴×Atorvastatin 三組已於
// js/mockData.js 新增人工彙整規則並補進 EXPECTED 表；其餘品項（銀杏、
// 大蒜精、人蔘、甘草、聖約翰草、魚油、鐵劑、蔓越莓）在人工規則庫（本測試
// 使用的 LOCAL_RULES，不含 DDInter 匯入規則）中沒有任何一組命中，
// 因此 EXPECTED 表無需為它們新增項目，已逐一實測確認。
check('配對總數為 C(70,2) = 2415（目錄擴充後此數需同步更新）', pairCount === 2415,
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

// Ibuprofen 已於 2026-09-02 收錄進目錄，改用確定不存在的藥名
const rUnknown = E.analyze([{ name_en: 'Zzyzxatinib' }, { atc: 'B01AA03' }], LOCAL_RULES);
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
// 嚴重度無法辨識者歸入 ungraded（分層呈現），但絕不可被丟棄——
// 丟棄會讓一條真實存在的交互作用從畫面上消失。
check('嚴重度無法辨識的規則仍會命中，並歸入 ungraded 而非被丟棄',
      rWeird.ungraded.length === 1 && rWeird.ungraded[0].severityUnknown === true
      && rWeird.findings.length === 0);
check('只有未分級結果時，結論為 unevaluable 而非 no-known-interaction',
      rWeird.verdict === 'unevaluable',
      '實得 ' + rWeird.verdict + '——知識庫查到了東西，說「未發現」是不實陳述');

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

// ---------------------------------------------------------------
// 十、DDInter 匯入的規則必須真的進到引擎裡
// ---------------------------------------------------------------
// 這一節的來由值得記下來：DDInter 的匯入工具寫好了、236 條規則產生了、
// 檔案也進了版控——但四個實際做比對的地方沒有一個載入它。
// 規則只在管理後台被拿來顯示「知識庫共 N 條」的統計數字，
// 醫師端與病患端的比對從頭到尾用的還是人工維護的那 5 條。
//
// 這是稽核報告 P0-7 那個教訓的另一種形式：
// 「測試通過不等於使用者看到的是對的」，這次是「資料匯入了不等於引擎用得到」。
// 上面第一到九節全部用 LOCAL_RULES（人工規則）測，所以 45 項全過，
// 卻完全沒有察覺畫面上少了 236 條規則。
//
// 因此本節一律改用 E.localRuleSet()——production 四個呼叫點用的同一個函式。
// 測試與畫面吃同一份規則，才不可能再各自漂移。
require('../js/ddi-rules-ddinter.js');
const MERGED = E.localRuleSet();
const nCurated = E.normalizeRules(LOCAL_RULES).rules.length;
const nMerged = E.normalizeRules(MERGED).rules.length;

check('localRuleSet() 確實含入 DDInter 規則（修復前這 236 條從未進入比對）',
      nMerged > nCurated,
      '人工規則 ' + nCurated + ' 條，合併後 ' + nMerged + ' 條——沒有增加代表 DDInter 未被載入');
check('DDInter 規則檔本身非空且標記為 severity-only',
      !!global.window.DDINTER_RULES && global.window.DDINTER_RULES.rules.length > 0
      && global.window.DDINTER_RULES.detailLevel === 'severity-only');

// 【合併順序的臨床意義】人工維護的規則帶有作用機轉、處置建議與 ACR 出處；
// DDInter 的同一組只有一個嚴重度。去重時若讓 DDInter 勝出，醫師會從
// 「應避免併用，必須併用時監測 INR 與出血徵兆」退化成一個沒有下文的「major」。
const rWA = E.analyze([{ atc: 'B01AA03' }, { atc: 'B01AC06' }], MERGED);
check('人工規則不被 DDInter 覆蓋：Warfarin × Aspirin 仍保有處置建議與作用機轉',
      rWA.findings.length >= 1 && !!rWA.findings[0].recommendation && !!rWA.findings[0].effect,
      '合併後該組的處置建議遺失，代表去重取到了 DDInter 的精簡版本');
check('人工規則合併後仍標記為 full（不會被誤標為僅有嚴重度）',
      rWA.findings[0].detailLevel === 'full');

// 【單調性】增加規則只會讓警示變多，不會讓原本查得到的組合突然查不到。
// 這是合併邏輯最容易出錯的地方：去重的鍵若寫錯，會把兩條不同的規則當成同一條丟掉一條。
const lost = [];
for (const [key, expected] of Object.entries(EXPECTED)) {
  const [a, b] = key.split('|');
  const r = E.analyze([{ atc: a }, { atc: b }], MERGED);
  const got = r.findings.length ? r.findings[0].severity : null;
  if (got !== expected) lost.push(key + ' 預期仍為 ' + expected + '，實得 ' + (got || '無'));
}
check('合併 DDInter 後，原有的 5 組人工規則結論完全不變（增加規則不得使既有警示消失）',
      lost.length === 0, lost.join('\n        '));

// 【出處可稽核】第八節要求每條人工規則都有出處與複核日期。DDInter 的規則
// 做不到「處置建議」那一項（原始資料就沒有），但出處與匯入日期必須有——
// 否則畫面上會出現一則沒有任何依據、也不知道是什麼時候進來的警示。
const merged = E.normalizeRules(MERGED).rules;
const fromDdinter = merged.filter(r => r.detailLevel === 'severity-only');
check('DDInter 規則確實佔多數且可辨識（' + fromDdinter.length + ' 條）',
      fromDdinter.length > 0);
check('每條 DDInter 規則都帶有出處，可供醫師判斷依據',
      fromDdinter.every(r => !!r.source),
      '有 ' + fromDdinter.filter(r => !r.source).length + ' 條缺出處');
check('每條 DDInter 規則都帶有匯入日期（相當於複核日期）',
      fromDdinter.every(r => !!r.reviewedOn));
check('DDInter 規則不得憑空生出處置建議（原始資料沒有，就不可以有）',
      fromDdinter.every(r => !r.recommendation));

// 【未分級不可被當成中度】DDInter 有 4 萬餘筆嚴重度為 Unknown，
// 匯入時 severity 為 null。若正規化把它當成 moderate，畫面會斗大地寫「中度」，
// 那是引擎替原始資料捏造了一個它沒說的分級。
const nullSev = global.window.DDINTER_RULES.rules.filter(r => r.severity === null);
check('DDInter 中確實存在嚴重度未分級的規則（' + nullSev.length + ' 條）', nullSev.length > 0);
if (nullSev.length) {
  const one = nullSev[0];
  const rNull = E.analyze([{ atc: one.atcA }, { atc: one.atcB }], MERGED);
  const hit = rNull.ungraded.find(f => f.severityUnknown);
  check('嚴重度未分級的規則命中後標記為 unknown 而非 moderate',
        !!hit && hit.severity === 'unknown',
        '實得 ' + (hit ? hit.severity : '未命中'));
  check('未分級的排序權重低於 minor（不可壓過有明確記載的輕微交互作用）',
        E.SEVERITY.unknown.rank < E.SEVERITY.minor.rank);
}

// ---------------------------------------------------------------
// 十一、分級與未分級的分層（警示疲勞控制）
// ---------------------------------------------------------------
// DDInter 匯入的 224 條中有 116 條的嚴重度是原始資料庫標的 Unknown。
// 實測若與已分級者並列呈現：示範病患 P001–P003 全數從「未發現」翻成 risk，
// 病患端首頁會寫「有 11 組已知交互作用」，其中 6 組不知道多嚴重。
// 稽核報告 P1-13：過度警示會訓練醫師忽略所有警示，連真正重要的那則也一起。
//
// 分層的兩個方向都要守住：既不能讓未分級的淹沒主要警示，
// 也不能讓它們消失（丟掉等於宣稱這些記載不存在）。
const rWangMing = E.analyze(mock.patient.medications || [], MERGED);
check('王大明：已分級與未分級確實被分開',
      rWangMing.findings.length > 0 && rWangMing.ungraded.length > 0,
      '已分級 ' + rWangMing.findings.length + '，未分級 ' + rWangMing.ungraded.length);
check('主要警示區不含任何未分級項目（警示疲勞的控制點）',
      rWangMing.findings.every(f => !f.severityUnknown));
check('未分級項目全數保留未被丟棄（丟掉等於宣稱這些記載不存在）',
      rWangMing.ungraded.every(f => f.severityUnknown));
check('王大明最嚴重者仍為 major，未被未分級項目稀釋掉',
      rWangMing.topSeverity === 'major');

// topSeverity 只由已分級者決定，這是 Phase 4 處方攔截的輸入。
// 攔截是強制性的臨床流程約束，不能建立在「不知道多嚴重」的記載上。
const onlyUngraded = E.analyze([{ atc: 'B01AC06' }, { atc: 'C01BD01' }], MERGED);
check('只有未分級結果時 topSeverity 為 null（不得觸發 Phase 4 處方攔截）',
      onlyUngraded.ungraded.length > 0 && onlyUngraded.topSeverity === null,
      '未分級 ' + onlyUngraded.ungraded.length + '，topSeverity ' + onlyUngraded.topSeverity);
check('只有未分級結果時 verdict 為 unevaluable（三種合法值之一，Firestore 規則才收）',
      ['risk', 'unevaluable', 'no-known-interaction'].includes(onlyUngraded.verdict)
      && onlyUngraded.verdict === 'unevaluable');

// 分層之後，P001–P003 不應再因為未分級的記載而被整批標成 risk
const p001 = E.analyze(mock.patients.P001.medications || [], MERGED);
check('P001 的 risk 判定只來自已分級的交互作用',
      p001.verdict === (p001.findings.length ? 'risk' : 'unevaluable'));

// 【誠實結論不因規則變多而失守】規則庫擴大後最容易鬆掉的就是這一條：
// 成分不明的複方仍然不可被判定為「未發現交互作用」。
const rMultiMerged = E.analyze([{ atc: 'A11A' }, { atc: 'C09AA03' }], MERGED);
check('合併後，成分不明的複方仍不可呈現為未發現交互作用',
      rMultiMerged.verdict !== 'no-known-interaction');

// 【防禦性】DDInter 檔案未載入時（例如某個頁面漏掉 script 標籤），
// localRuleSet() 必須安靜地退回人工規則，而不是整個崩掉讓畫面空白。
const savedDdinter = global.window.DDINTER_RULES;
global.window.DDINTER_RULES = undefined;
const fallback = E.localRuleSet();
check('DDInter 未載入時 localRuleSet() 退回人工規則而不拋錯',
      Array.isArray(fallback) && fallback.length === LOCAL_RULES.length);
global.window.DDINTER_RULES = savedDdinter;

// --- 輸出 ---
console.log('');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '\n      ' + r[2] : '');
const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
