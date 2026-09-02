// 【自動產生，請勿手動編輯】
// 由 tools/import-ddinter.mjs 於 2026-09-02 從 DDInter 2.0 匯入。
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
  importedOn: '2026-09-02',
  detailLevel: 'severity-only',
  rules: [
  { drugA: "Metformin", drugB: "Vitamin D3", atcA: 'A10BA02', atcB: 'A11CC05', severity: null },
  { drugA: "Metformin", drugB: "Warfarin", atcA: 'A10BA02', atcB: 'B01AA03', severity: 'moderate' },
  { drugA: "Metformin", drugB: "Aspirin", atcA: 'A10BA02', atcB: 'B01AC06', severity: null },
  { drugA: "Metformin", drugB: "Amiodarone", atcA: 'A10BA02', atcB: 'C01BD01', severity: null },
  { drugA: "Metformin", drugB: "Lisinopril", atcA: 'A10BA02', atcB: 'C09AA03', severity: 'moderate' },
  { drugA: "Metformin", drugB: "Atorvastatin", atcA: 'A10BA02', atcB: 'C10AA05', severity: null },
  { drugA: "Warfarin", drugB: "Vitamin D3", atcA: 'B01AA03', atcB: 'A11CC05', severity: null },
  { drugA: "Warfarin", drugB: "Aspirin", atcA: 'B01AA03', atcB: 'B01AC06', severity: 'major' },
  { drugA: "Warfarin", drugB: "Amiodarone", atcA: 'B01AA03', atcB: 'C01BD01', severity: 'major' },
  { drugA: "Warfarin", drugB: "Lisinopril", atcA: 'B01AA03', atcB: 'C09AA03', severity: null },
  { drugA: "Warfarin", drugB: "Atorvastatin", atcA: 'B01AA03', atcB: 'C10AA05', severity: 'minor' },
  { drugA: "Aspirin", drugB: "Vitamin D3", atcA: 'B01AC06', atcB: 'A11CC05', severity: null },
  { drugA: "Aspirin", drugB: "Amiodarone", atcA: 'B01AC06', atcB: 'C01BD01', severity: null },
  { drugA: "Aspirin", drugB: "Atorvastatin", atcA: 'B01AC06', atcB: 'C10AA05', severity: null },
  { drugA: "Lisinopril", drugB: "Vitamin D3", atcA: 'C09AA03', atcB: 'A11CC05', severity: null },
  { drugA: "Lisinopril", drugB: "Aspirin", atcA: 'C09AA03', atcB: 'B01AC06', severity: 'moderate' },
  { drugA: "Lisinopril", drugB: "Amiodarone", atcA: 'C09AA03', atcB: 'C01BD01', severity: null },
  { drugA: "Lisinopril", drugB: "Atorvastatin", atcA: 'C09AA03', atcB: 'C10AA05', severity: null },
  { drugA: "Atorvastatin", drugB: "Vitamin D3", atcA: 'C10AA05', atcB: 'A11CC05', severity: null },
  { drugA: "Atorvastatin", drugB: "Amiodarone", atcA: 'C10AA05', atcB: 'C01BD01', severity: 'moderate' },
  ]
};

if (typeof module !== 'undefined' && module.exports) module.exports = window.DDINTER_RULES;
