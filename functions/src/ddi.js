// 在 Node 環境載入病患端使用的同一套 DDI 引擎。
//
// 【為什麼一定要用同一份檔案，而不是在伺服器端重寫一次判斷】
// 這個系統的核心主張是「跨院用藥交互作用偵測」。如果 LINE 推播用的是另一套
// 實作，遲早會出現「醫師端說有、LINE 說沒有」——那不只是 bug，是把系統
// 唯一的賣點變成一件不可信的事。因此寧可接受「複製檔案」的部署麻煩
// （見 sync-vendor.js），也不接受兩份判斷邏輯。
//
// 載入方式沿用 tests/ddi-engine.test.mjs 已經在用的手法：先造一個 global.window，
// 再 require 那些原本掛在 window 上的瀏覽器腳本。順序與 patient.html 的
// <script> 標籤相同，不可調換。

let engine = null;
let rules = null;

function load() {
  if (engine) return;
  global.window = global.window || {};
  require('../vendor/drug-catalog.js');
  require('../vendor/ddinter-drugs.js');
  require('../vendor/ddi-engine.js');
  require('../vendor/ddi-rules-ddinter.js');
  engine = global.window.DdiEngine;
  rules = engine.localRuleSet();
}

// 分析一份用藥清單。回傳與前端 analyze() 完全相同的結構。
function analyze(medications) {
  load();
  return engine.analyze(medications || [], rules);
}

// 只挑出「該立刻讓病患知道」的那幾則。
//
// 【為什麼只有 major 與 contraindicated】
// 引擎已經把未分級（DDInter 標為 Unknown）的結果另放在 ungraded，不混進 findings，
// 理由見 ddi-engine.js 裡關於警示疲勞的長註解。推播比畫面更需要這個克制：
// 畫面上多一列使用者可以略過，手機震動一次不行。一個會為了 minor 交互作用
// 打斷長輩三次的系統，最後的下場是他把官方帳號封鎖，連真正重要的那一則
// 也一起收不到。
const PUSH_WORTHY = ['contraindicated', 'major'];

function pushWorthyFindings(result) {
  return (result.findings || []).filter(f => PUSH_WORTHY.indexOf(f.severity) !== -1);
}

// 把 finding 兩端接回原始的用藥紀錄。
//
// 【為什麼需要這一層】
// 引擎回傳的 f.a / f.b 是它自己正規化過的 entry（欄位是 raw / atc /
// name_en / name_zh），不是呼叫端傳進去的那個 medication 物件——
// 因此 f.a.zhName 與 f.a.hospital 都會是 undefined。
// 而「這兩個藥分別來自哪一家醫院」正是跨院警示唯一的說服力來源，
// 少了它，訊息就退化成一則普通的用藥提醒。
//
// 比對優先用 ATC（引擎本來就是按 ATC 判定的），名稱只作為後備。
function describe(entry, meds) {
  if (!entry) return { name: '（未知）', hospital: '' };
  const raw = (meds || []).find(m =>
    (entry.atc && m.atc === entry.atc) ||
    (entry.raw && String(m.name || '').toLowerCase() === String(entry.raw).toLowerCase())
  );
  return {
    name: entry.name_zh || entry.name_en || (raw && (raw.zhName || raw.name)) || '（未知）',
    hospital: (raw && raw.hospital) || ''
  };
}

// 在 findings 上補一組 display 欄位，供訊息版型直接使用。
function decorate(findings, meds) {
  return (findings || []).map(f => Object.assign({}, f, {
    display: { a: describe(f.a, meds), b: describe(f.b, meds) }
  }));
}

module.exports = { analyze, pushWorthyFindings, decorate, describe, PUSH_WORTHY };
