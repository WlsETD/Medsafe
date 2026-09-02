// DDInter 2.0 匯入工具（原型）
//
// 把 DDInter 的原始 CSV 轉成本系統交互作用引擎可用的規則檔。
//
//   輸入：DDINTER2/ddinter_downloads_code_*.csv（本機，不進版控、不部署）
//   輸出：js/ddi-rules-ddinter.js（進版控、可部署）
//
// 執行：node tools/import-ddinter.mjs           # 只報告涵蓋率，不寫檔
//       node tools/import-ddinter.mjs --emit    # 產生規則檔
//
// ── 設計上的三個硬性決定 ────────────────────────────────────
//
// 一、【只輸出兩端都能解析為 ATC 碼的規則】
//     DDInter 的 CSV 是以「藥名」為鍵，而本系統的引擎以 ATC 碼比對——
//     那是 P1-10 的修復，不能為了衝規則數而退回藥名比對。
//     解析不到的組合寧可不收，也不要收進一批比對不到的死規則：
//     那只會讓 ruleCount 虛胖，讓醫師以為知識庫比實際更完整。
//
// 二、【DDInter 的 Unknown 嚴重度予以保留，但標記為未分級】
//     42,415 筆的嚴重度是 Unknown。把它們丟掉等於宣稱這些交互作用不存在；
//     把它們當成 moderate 則是替原始資料捏造一個它沒說的分級。
//     引擎本來就有 severityUnknown 旗標，UI 會顯示「嚴重度未分級」。
//
// 三、【明確標記本批規則「只有嚴重度，沒有機轉與處置建議」】
//     原始 CSV 只有 Drug_A / Drug_B / Level 三個有用欄位，
//     沒有作用機轉，也沒有臨床處置建議。稽核報告 P1-13 要求每條規則
//     都要有處置建議——手工維護的 5 條做得到，這批做不到。
//     因此每條都帶 detailLevel: 'severity-only'，讓 UI 據實說明，
//     而不是留白讓醫師以為系統沒話說。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

global.window = {};
require(path.join(ROOT, 'js/drug-catalog.js'));
const Catalog = global.window.DrugCatalog;

// ── CSV 解析：必須處理引號內的逗號 ──────────────────────────
// 資料中確實有 "Thyroid, desiccated"、"Insulin, porcine" 這類藥名。
// 用 split(',') 會把它們切成兩半，導致 Level 欄位讀到半個藥名——
// 第一次嘗試就踩到這個坑，統計出現了 196 筆嚴重度叫「Live"」的規則。
function parseCsvLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const LEVEL_MAP = {
  Major: 'major',
  Moderate: 'moderate',
  Minor: 'minor',
  Unknown: null      // 保留該筆，但不宣稱分級
};

function main() {
  const emit = process.argv.includes('--emit');
  const srcDir = path.join(ROOT, 'DDINTER2');
  if (!fs.existsSync(srcDir)) {
    console.error('找不到 DDINTER2/。請先下載原始 CSV（見 DEPLOY_CHECKLIST.md）。');
    process.exit(1);
  }
  const files = fs.readdirSync(srcDir).filter(f => /^ddinter_downloads_code_[A-Z]\.csv$/.test(f)).sort();
  if (!files.length) { console.error('DDINTER2/ 中沒有符合命名的 CSV。'); process.exit(1); }

  const seenPair = new Set();     // 去重：同一組藥不論在哪個檔案出現都只算一次
  const unresolved = new Map();   // 解析不到的藥名 → 出現次數
  const rules = [];
  let totalRows = 0, malformed = 0, dupes = 0;

  for (const f of files) {
    const lines = fs.readFileSync(path.join(srcDir, f), 'utf8').split(/\r?\n/);
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      totalRows++;
      const c = parseCsvLine(line);
      if (c.length !== 5) { malformed++; continue; }
      const nameA = c[1].trim(), nameB = c[3].trim(), level = c[4].trim();
      if (!(level in LEVEL_MAP)) { malformed++; continue; }

      const key = [nameA.toLowerCase(), nameB.toLowerCase()].sort().join('|');
      if (seenPair.has(key)) { dupes++; continue; }
      seenPair.add(key);

      const a = Catalog.resolve(nameA);
      const b = Catalog.resolve(nameB);
      if (!a) unresolved.set(nameA, (unresolved.get(nameA) || 0) + 1);
      if (!b) unresolved.set(nameB, (unresolved.get(nameB) || 0) + 1);
      if (!a || !b) continue;
      // 同一種藥的兩個 ATC 別名（如 aspirin 的 B01AC06 與 N02BA01）
      // 會解析成同一個藥物物件，那不是交互作用，是同一種藥
      if (a.atc === b.atc) continue;

      rules.push({
        drugA: a.name_en, drugB: b.name_en,
        atcA: a.atc, atcB: b.atc,
        severity: LEVEL_MAP[level],
        origLevel: level
      });
    }
  }

  // ── 報告 ──────────────────────────────────────────────────
  const pct = (n, d) => d ? (n / d * 100).toFixed(2) + '%' : '—';
  console.log('');
  console.log('════ DDInter 匯入報告 ════');
  console.log('  來源檔案            : ' + files.length + ' 個');
  console.log('  原始資料列          : ' + totalRows.toLocaleString());
  console.log('  格式異常（已略過）  : ' + malformed.toLocaleString());
  console.log('  重複組合（已去重）  : ' + dupes.toLocaleString());
  console.log('  去重後不重複組合    : ' + seenPair.size.toLocaleString());
  console.log('');
  console.log('  ── 對映結果 ──');
  console.log('  兩端皆可解析為 ATC  : ' + rules.length.toLocaleString()
              + '  (' + pct(rules.length, seenPair.size) + ')');
  console.log('  無法解析的藥名      : ' + unresolved.size.toLocaleString() + ' 種');
  console.log('');
  const byLevel = {};
  for (const r of rules) { const k = r.origLevel; byLevel[k] = (byLevel[k] || 0) + 1; }
  console.log('  ── 可用規則的嚴重度分佈 ──');
  for (const k of ['Major', 'Moderate', 'Minor', 'Unknown']) {
    console.log('  ' + (k + '          ').slice(0, 20) + (byLevel[k] || 0).toLocaleString());
  }
  console.log('');
  console.log('  ── 目前目錄涵蓋率的瓶頸（出現最多次卻解析不到的藥名）──');
  const top = [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [name, n] of top) {
    console.log('  ' + String(n).padStart(6) + ' 次  ' + name);
  }
  console.log('');
  console.log('  目錄現有藥物數      : ' + Catalog.all().length);
  console.log('  ※ 可用規則數直接受目錄大小限制。目錄每擴充一種常見藥，');
  console.log('     可用規則通常會增加數十到數百條。');

  if (!emit) {
    console.log('');
    console.log('（未加 --emit，本次不寫檔）');
    return;
  }

  // ── 產出規則檔 ────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const body = rules
    .sort((x, y) => (x.atcA + x.atcB).localeCompare(y.atcA + y.atcB))
    .map(r => {
      const sev = r.severity ? `'${r.severity}'` : 'null';
      return `  { drugA: ${JSON.stringify(r.drugA)}, drugB: ${JSON.stringify(r.drugB)},`
           + ` atcA: '${r.atcA}', atcB: '${r.atcB}', severity: ${sev} },`;
    }).join('\n');

  const out = `// 【自動產生，請勿手動編輯】
// 由 tools/import-ddinter.mjs 於 ${today} 從 DDInter 2.0 匯入。
// 重新產生：node tools/import-ddinter.mjs --emit
//
// 資料來源：DDInter 2.0（https://ddinter2.scbdd.com）
//   Tian et al., DDInter 2.0: an enhanced drug interaction resource with expanded
//   data coverage, new interaction types and improved user interface.
//   Nucleic Acids Research, 2025, 53(D1): D1356–D1364.
//
// ── 使用這批規則時必須知道的三件事 ──────────────────────────
//
// 一、只含嚴重度，沒有作用機轉與處置建議。原始 CSV 只提供 Drug_A / Drug_B / Level
//     三個欄位。因此每條規則都標記 detailLevel: 'severity-only'，
//     UI 必須據實說明「本條僅有嚴重度分級，請另行查證機轉與處置方式」，
//     不可留白讓醫師以為系統沒有話說。
//
// 二、severity 為 null 代表 DDInter 標記為 Unknown（原始資料中有 4 萬餘筆）。
//     那是「已知有交互作用，但嚴重度未分級」，不是「輕微」也不是「沒有」。
//     引擎的 severityUnknown 旗標會讓 UI 顯示「嚴重度未分級」。
//
// 三、只收錄兩端都能解析為 ATC 碼的組合。本系統的引擎以 ATC 比對（稽核報告 P1-10），
//     不以藥名比對。解析不到的組合寧可不收，也不要收進一批永遠比對不到的死規則——
//     那只會讓知識庫的規則數虛胖，讓醫師以為涵蓋範圍比實際更廣。
//     因此本檔的規則數直接受 js/drug-catalog.js 的目錄大小限制。

window.DDINTER_RULES = {
  source: 'DDInter 2.0 (ddinter2.scbdd.com)',
  citation: 'Nucleic Acids Research 2025, 53(D1):D1356-D1364',
  importedOn: '${today}',
  detailLevel: 'severity-only',
  rules: [
${body}
  ]
};

if (typeof module !== 'undefined' && module.exports) module.exports = window.DDINTER_RULES;
`;

  const outPath = path.join(ROOT, 'js/ddi-rules-ddinter.js');
  fs.writeFileSync(outPath, out);
  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log('');
  console.log('  已產生 js/ddi-rules-ddinter.js（' + rules.length.toLocaleString() + ' 條，' + kb + ' KB）');
}

main();
