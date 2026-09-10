// 把病患端使用的 DDI 引擎與藥物目錄複製到 functions/vendor/。
//
// 【為什麼要複製而不是 require 上層目錄】
// Firebase Functions 部署時只會打包 functions/ 這個目錄，`require('../js/...')`
// 在雲端會找不到檔案（本機測起來卻正常，是最難查的那種失敗）。
//
// 【為什麼不手動維護一份副本】
// 這個專案已經有一個「同一份資料要在三個地方保持同步」的坑
// （展示帳號白名單，見 firestore.rules 的 isDemoPatientUsername 註解）。
// 再開一個手動同步點，遲早會出現「醫師端說有交互作用、LINE 說沒有」——
// 而那正是本系統最不能出現的錯誤。因此改由 predeploy hook 每次自動重產，
// 且 vendor/ 不進版控（見 .gitignore），讓「舊副本」在結構上不可能存在。
//
// 由 firebase.json 的 functions.predeploy 呼叫，也可手動 `npm run sync-vendor`。

const fs = require('fs');
const path = require('path');

// 順序有意義：drug-catalog 必須先於 ddi-engine，ddi-rules 必須後於 ddi-engine
// （與 patient.html / dashboard.html 的 <script> 載入順序相同的理由）。
const FILES = [
  'drug-catalog.js',
  'ddinter-drugs.js',
  'ddi-engine.js',
  'ddi-rules-ddinter.js'
];

const srcDir = path.join(__dirname, '..', 'js');
const outDir = path.join(__dirname, 'vendor');

fs.mkdirSync(outDir, { recursive: true });

let total = 0;
for (const f of FILES) {
  const src = path.join(srcDir, f);
  if (!fs.existsSync(src)) {
    console.error(`[sync-vendor] 找不到來源檔案：${src}`);
    process.exit(1);
  }
  const buf = fs.readFileSync(src);
  fs.writeFileSync(path.join(outDir, f), buf);
  total += buf.length;
  console.log(`[sync-vendor] ${f}  ${(buf.length / 1024).toFixed(1)} KB`);
}
console.log(`[sync-vendor] 完成，共 ${FILES.length} 個檔案 / ${(total / 1024).toFixed(1)} KB`);
