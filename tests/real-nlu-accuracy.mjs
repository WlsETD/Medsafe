// 真實 gpt-4o-mini 語意理解準確率測試（P4 用）。
//
// 跟 tests/line-nlu.test.mjs 的差別只有一件事：這支「不 mock LLM，直接打正式的
// gpt-4o-mini」。判定邏輯完全沿用 functions/src/nlu.js 的正式流程（同一份
// processUserInput），確保這裡量到的是「李部署到 production 的那套邏輯」，
// 不是另外寫一套簡化版來討好數字。
//
// 執行方式（在 Security-main 資料夾下）：
//   node tests/real-nlu-accuracy.mjs
//
// 需要 functions/.env 或 functions/.env.<project-id>（例如 .env.medsafe-554b7）
// 裡已經有 OPENAI_API_KEY=sk-...—— 跟你本機開發、emulator 用的是同一份設定，
// 這支腳本只是照 Firebase 的規則自己把它讀進 process.env，金鑰不會被印出來、
// 也不會離開你的電腦。
//
// 成本：64 句 × 1 次 gpt-4o-mini 呼叫，每句 prompt 約 3-400 tokens，
// 全部跑完大概新台幣 1 元有找。建議先跑一次留存結果，不用排進 CI 常態執行。

import { createRequire } from 'module';
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.join(__dirname, '..', 'functions');

// ── 手動載入 .env（比照 Firebase CLI 的順序：.env 先、.env.<project-id> 覆蓋）──
function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[m[1]] = val;
  }
}
loadEnvFile(path.join(FUNCTIONS_DIR, '.env'));
if (existsSync(FUNCTIONS_DIR)) {
  for (const name of readdirSync(FUNCTIONS_DIR)) {
    if (/^\.env\.[^.]+$/.test(name)) loadEnvFile(path.join(FUNCTIONS_DIR, name));
  }
}
// defineSecret() 的值不放在 .env，Firebase 本機測試機密參數的標準位置是
// functions/.secret.local（不進 git）。.env 只放非機密的 defineString 參數。
loadEnvFile(path.join(FUNCTIONS_DIR, '.secret.local'));
if (existsSync(FUNCTIONS_DIR)) {
  for (const name of readdirSync(FUNCTIONS_DIR)) {
    if (/^\.secret\.local\.[^.]+$/.test(name)) loadEnvFile(path.join(FUNCTIONS_DIR, name));
  }
}

if (!process.env.OPENAI_API_KEY) {
  console.error('找不到 OPENAI_API_KEY。請在 functions/.secret.local 建一行 OPENAI_API_KEY=sk-...（這是 Firebase 本機測試機密參數的標準位置，不是 .env）。');
  process.exit(1);
}

const llm = require(path.join(FUNCTIONS_DIR, 'src', 'llm.js'));
const nlu = require(path.join(FUNCTIONS_DIR, 'src', 'nlu.js'));
void llm; // 不 mock，直接讓 nlu.js 內部走 llm.openaiCall 打正式 API

// ── 王大明（P4 引用的測試病患，取自 js/mockData.js 的 patient01）──
const PATIENT = {
  medications: [
    { atc: 'B01AA03', name: 'Warfarin', zhName: '華法林', category: '抗凝血劑', hospital: '台大醫院' },
    { atc: 'B01AC06', name: 'Aspirin', zhName: '阿斯匹靈', category: '非類固醇消炎藥', hospital: '長庚醫院' },
    { atc: 'A10BA02', name: 'Metformin', zhName: '二甲雙胍', category: '降血糖藥', hospital: '榮總醫院' },
    { atc: 'C09AA03', name: 'Lisinopril', zhName: '賴諾普利', category: '降血壓藥', hospital: '台大醫院' },
    { atc: 'A11CC05', name: 'Vitamin D3', zhName: '維生素 D3', category: '營養補充', hospital: '馬偕醫院' },
    { atc: 'A11A', name: 'Multivitamin', zhName: '綜合維他命', category: '營養補充', hospital: '台大醫院' }
  ],
  reminders: [
    { time: '08:00', text: '服用阿斯匹靈、賴諾普利' },
    { time: '12:00', text: '服用二甲雙胍 (飯後)' },
    { time: '20:00', text: '服用華法林' }
  ]
};

// ── 輔助判定：只看「最終決策對不對」，不逐字比對 LLM 原始輸出 ──
function hasTaken(r, atc) { return r.status === 'ok' && r.toRecord.some(x => x.med.atc === atc); }
function hasNotRecorded(r, atc, action) {
  return r.status === 'ok' && r.notRecorded.some(x => x.med && x.med.atc === atc && x.action === action);
}
function isNoSlot(r, atc) {
  return r.status === 'ok' && r.notRecorded.some(x => x.med && x.med.atc === atc && x.reason === 'no-slot');
}
// 語氣不確定／低信心度時，唯一不能違反的規則是「不得自動寫入」——
// 到底落在 confirm 追問還是 notRecorded(uncertain)，兩者都算安全，不強求哪一種。
function notAutoWritten(r, atc) { return r.status === 'ok' && !hasTaken(r, atc); }
function isUnmatchedOrEmpty(r) {
  if (!r || r.status !== 'ok') return true;
  return (r.unmatched && r.unmatched.length > 0) || r.toRecord.length === 0;
}
function hasAmbiguousCandidate(r) { return r.status === 'ok' && r.confirm.some(c => c.kind === 'pick-drug'); }

// ── 64 句測試集：8 類語法 × 8 句（對應 P4「8 類 涵蓋句型」的實際內容）──
const CASES = [
  // A. 正式學名／商品名
  { cat: 'A-藥名', text: '阿斯匹靈吃了', check: r => hasTaken(r, 'B01AC06') },
  { cat: 'A-藥名', text: '華法林吃了', check: r => hasTaken(r, 'B01AA03') },
  { cat: 'A-藥名', text: '二甲雙胍吃了', check: r => hasTaken(r, 'A10BA02') },
  { cat: 'A-藥名', text: '賴諾普利吃了', check: r => hasTaken(r, 'C09AA03') },
  { cat: 'A-藥名', text: '維生素D3吃了', check: r => isNoSlot(r, 'A11CC05') },
  { cat: 'A-藥名', text: '吃了立普妥', check: r => isUnmatchedOrEmpty(r) }, // 立普妥非王大明用藥，不得誤配
  { cat: 'A-藥名', text: '吃了維骨力', check: r => isUnmatchedOrEmpty(r) }, // 非清單內藥物，防幻覺
  { cat: 'A-藥名', text: '吃了維他命', check: r => hasAmbiguousCandidate(r) || hasTaken(r, 'A11A') || hasTaken(r, 'A11CC05') },

  // B. 口語／類別代稱（不講學名，講「哪一種藥」）
  { cat: 'B-口語', text: '血壓藥吃了', check: r => hasTaken(r, 'C09AA03') },
  { cat: 'B-口語', text: '血糖藥吃了', check: r => hasTaken(r, 'A10BA02') },
  { cat: 'B-口語', text: '抗凝血的藥吃了', check: r => hasTaken(r, 'B01AA03') },
  { cat: 'B-口語', text: '消炎藥吃了', check: r => hasTaken(r, 'B01AC06') },
  { cat: 'B-口語', text: '降壓藥還沒吃', check: r => hasNotRecorded(r, 'C09AA03', 'skipped') },
  { cat: 'B-口語', text: '血糖的那顆忘記吃了', check: r => hasNotRecorded(r, 'A10BA02', 'skipped') },
  { cat: 'B-口語', text: '抗凝血劑好像吃了吧', check: r => notAutoWritten(r, 'B01AA03') },
  { cat: 'B-口語', text: '血壓藥好像有吃齁', check: r => notAutoWritten(r, 'C09AA03') },

  // C. 時段指涉（不點名藥物，用時間代稱）
  { cat: 'C-指涉', text: '早上的藥都吃了', check: r => hasTaken(r, 'B01AC06') && hasTaken(r, 'C09AA03') },
  { cat: 'C-指涉', text: '晚上的藥吃了', check: r => hasTaken(r, 'B01AA03') },
  { cat: 'C-指涉', text: '中午的藥吃了', check: r => hasTaken(r, 'A10BA02') },
  { cat: 'C-指涉', text: '晚上的忘記吃', check: r => hasNotRecorded(r, 'B01AA03', 'skipped') },
  { cat: 'C-指涉', text: '中午那顆還沒吃', check: r => hasNotRecorded(r, 'A10BA02', 'skipped') },
  { cat: 'C-指涉', text: '早上兩顆都忘記吃', check: r => hasNotRecorded(r, 'B01AC06', 'skipped') && hasNotRecorded(r, 'C09AA03', 'skipped') },
  { cat: 'C-指涉', text: '睡前的藥還沒吃', check: r => hasNotRecorded(r, 'B01AA03', 'skipped') },
  { cat: 'C-指涉', text: '早上兩顆都吃了', check: r => hasTaken(r, 'B01AC06') && hasTaken(r, 'C09AA03') },

  // D. 台語／長輩口語變體
  { cat: 'D-台語', text: '阿斯匹靈呷矣', check: r => hasTaken(r, 'B01AC06') },
  { cat: 'D-台語', text: '血壓仔的藥呷矣', check: r => hasTaken(r, 'C09AA03') },
  { cat: 'D-台語', text: '糖仔藥猶未呷', check: r => hasNotRecorded(r, 'A10BA02', 'skipped') },
  { cat: 'D-台語', text: '早頓彼兩粒藥仔攏呷矣', check: r => hasTaken(r, 'B01AC06') && hasTaken(r, 'C09AA03') },
  { cat: 'D-台語', text: '暗時彼粒猶未呷啦', check: r => hasNotRecorded(r, 'B01AA03', 'skipped') },
  { cat: 'D-台語', text: '血糖仔敢有呷', check: r => notAutoWritten(r, 'A10BA02') },
  { cat: 'D-台語', text: '血壓仔敢有呷未', check: r => notAutoWritten(r, 'C09AA03') },
  { cat: 'D-台語', text: '維他命嘛呷矣', check: r => hasAmbiguousCandidate(r) || hasTaken(r, 'A11A') || hasTaken(r, 'A11CC05') },

  // E. 一句多藥／混合動作
  { cat: 'E-多藥', text: '阿斯匹靈跟賴諾普利都吃了', check: r => hasTaken(r, 'B01AC06') && hasTaken(r, 'C09AA03') },
  { cat: 'E-多藥', text: '血壓藥吃了，血糖藥忘記', check: r => hasTaken(r, 'C09AA03') && hasNotRecorded(r, 'A10BA02', 'skipped') },
  { cat: 'E-多藥', text: '早上的藥吃了，晚上的還沒', check: r => hasTaken(r, 'B01AC06') && hasTaken(r, 'C09AA03') && hasNotRecorded(r, 'B01AA03', 'skipped') },
  { cat: 'E-多藥', text: '血壓藥跟抗凝血劑都吃了', check: r => hasTaken(r, 'C09AA03') && hasTaken(r, 'B01AA03') },
  { cat: 'E-多藥', text: '阿斯匹靈吃了，維生素D3也吃了', check: r => hasTaken(r, 'B01AC06') && isNoSlot(r, 'A11CC05') },
  { cat: 'E-多藥', text: '血糖藥跟抗凝血劑都還沒吃', check: r => hasNotRecorded(r, 'A10BA02', 'skipped') && hasNotRecorded(r, 'B01AA03', 'skipped') },
  { cat: 'E-多藥', text: '阿斯匹靈吃了，血糖藥還沒', check: r => hasTaken(r, 'B01AC06') && hasNotRecorded(r, 'A10BA02', 'skipped') },
  { cat: 'E-多藥', text: '早上藥吃了，血糖藥也吃了', check: r => hasTaken(r, 'B01AC06') && hasTaken(r, 'C09AA03') && hasTaken(r, 'A10BA02') },

  // F. 否定／不確定
  { cat: 'F-否定', text: '阿斯匹靈忘記吃了', check: r => hasNotRecorded(r, 'B01AC06', 'skipped') },
  { cat: 'F-否定', text: '抗凝血劑跳過沒吃', check: r => hasNotRecorded(r, 'B01AA03', 'skipped') },
  { cat: 'F-否定', text: '血糖藥還沒吃，晚點再吃', check: r => hasNotRecorded(r, 'A10BA02', 'skipped') },
  { cat: 'F-否定', text: '華法林應該是吃了吧', check: r => notAutoWritten(r, 'B01AA03') },
  { cat: 'F-否定', text: '維他命不確定有沒有吃', check: r => r.status === 'ok' && !hasTaken(r, 'A11A') && !hasTaken(r, 'A11CC05') },
  { cat: 'F-否定', text: '血壓藥不確定有吃過沒', check: r => notAutoWritten(r, 'C09AA03') },
  { cat: 'F-否定', text: '都還沒吃', check: r => r.status === 'no-extraction' || (r.status === 'ok' && r.toRecord.length === 0) },
  { cat: 'F-否定', text: '都吃了', check: r => r.status === 'no-extraction' || (r.status === 'ok' && r.toRecord.length === 0) },

  // G. 其他意圖（非服藥回報，測意圖分類）
  { cat: 'G-意圖', text: '我現在在吃什麼藥', check: r => r.status === 'intent' && r.intent === 'cabinet-query' },
  { cat: 'G-意圖', text: '幫我看藥箱', check: r => r.status === 'intent' && r.intent === 'cabinet-query' },
  { cat: 'G-意圖', text: '我想預約下次門診', check: r => r.status === 'intent' && r.intent === 'booking' },
  { cat: 'G-意圖', text: '下次可以改約禮拜五嗎', check: r => r.status === 'intent' && r.intent === 'booking' },
  { cat: 'G-意圖', text: '我下次回診是什麼時候', check: r => r.status === 'intent' && r.intent === 'next-visit' },
  { cat: 'G-意圖', text: '你們這個系統能幹嘛', check: r => r.status === 'intent' && r.intent === 'help' },
  { cat: 'G-意圖', text: '我今天頭很暈想吐', check: r => r.status === 'intent' && r.intent === 'discomfort' },
  { cat: 'G-意圖', text: '阿斯匹靈可以跟華法林一起吃嗎', check: r => r.status === 'intent' && r.intent === 'other' },

  // H. 干擾／幻覺防護（故意刁難）
  { cat: 'H-干擾', text: '今天天氣真好', check: r => r.status === 'intent' && r.intent === 'other' },
  { cat: 'H-干擾', text: '吃了一顆糖', check: r => r.status !== 'ok' || r.toRecord.length === 0 },
  { cat: 'H-干擾', text: '吃了維骨力', check: r => isUnmatchedOrEmpty(r) },
  { cat: 'H-干擾', text: '血壓藥跟感冒藥都吃了', check: r => hasTaken(r, 'C09AA03') && isUnmatchedOrEmpty(r) },
  { cat: 'H-干擾', text: '阿斯匹靈跟維骨力都吃了', check: r => hasTaken(r, 'B01AC06') && isUnmatchedOrEmpty(r) },
  { cat: 'H-干擾', text: '我朋友的血壓藥我也吃了一顆', check: r => hasTaken(r, 'C09AA03') || (r.status === 'ok' && r.confirm.length > 0) },
  { cat: 'H-干擾', text: '藥吃完了要去藥局補', check: r => r.status === 'intent' || (r.status === 'ok' && r.toRecord.length === 0) },
  { cat: 'H-干擾', text: '謝謝你', check: r => r.status === 'intent' && (r.intent === 'other' || r.intent === 'help') }
];

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

const run = async () => {
  const results = [];
  for (const c of CASES) {
    let r, error = null;
    for (let attempt = 0; attempt < 2 && !r; attempt++) {
      try {
        r = await nlu.processUserInput(c.text, PATIENT);
      } catch (e) {
        error = e.message;
        if (attempt === 0) await sleep(1000);
      }
    }
    let pass = false;
    try { pass = !error && c.check(r); } catch (e) { pass = false; error = '檢查函式出錯: ' + e.message; }
    results.push({ cat: c.cat, text: c.text, pass, raw: r || null, error });
    console.log((pass ? 'PASS ' : 'FAIL ') + c.cat.padEnd(8) + c.text);
    if (!pass) console.log('      →', error || JSON.stringify(r));
    await sleep(150); // 溫和一點，別炸 rate limit
  }

  const byCat = {};
  for (const r of results) {
    byCat[r.cat] = byCat[r.cat] || { pass: 0, total: 0 };
    byCat[r.cat].total++;
    if (r.pass) byCat[r.cat].pass++;
  }

  console.log('\n===== 分類別準確率 =====');
  for (const [cat, s] of Object.entries(byCat)) {
    console.log(cat.padEnd(10), s.pass + '/' + s.total, (100 * s.pass / s.total).toFixed(1) + '%');
  }

  const totalPass = results.filter(r => r.pass).length;
  console.log('\n===== 總計（可直接放上 P4）=====');
  console.log(totalPass + '/' + results.length + ' 句正確 = ' + (100 * totalPass / results.length).toFixed(1) + '%');

  const outPath = path.join(__dirname, 'real-nlu-accuracy-results.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log('\n完整結果（含每句原始輸出，方便挑失敗案例做投影片的誠實揭露）已存到:');
  console.log(outPath);
};

run();
