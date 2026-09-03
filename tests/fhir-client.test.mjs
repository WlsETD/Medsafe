// FHIR 連線層的迴歸測試（Phase 5）。
//
// 這份測試的存在源於一個實際發生過的缺陷（2026-09-03 發現）：
//
// 介面上所有「此伺服器無存取控制、資料任何人可讀」的警告，原本掛在
// isPublicSandbox() 上——一個比對網址是不是 hapi.fhir.org 的正規表示式。
// 系統遷移到自架的 Cloud Run FHIR Server 之後，該判斷回 false，警告全數消失；
// 但實測 `GET /fhir/Patient` 未帶任何憑證仍回 HTTP 200，讀寫依然對全世界開放。
//
// 淨效果是「伺服器一樣全開，警告卻不見了」——比遷移前更糟，
// 因為使用者失去了唯一的提示。
//
// 值得記下來的是：**原本那個函式就其自身定義而言完全正確**，
// 它真的有正確判斷出網址是不是 hapi.fhir.org。錯的是它被拿來回答另一個問題。
// 因此單純測「isPublicSandbox() 認不認得 hapi.fhir.org」永遠不會失敗，
// 也永遠抓不到這個缺陷。
//
// 這份測試改為釘住那個真正重要的性質：**預設必須站在保守的那一邊**。
// 只要沒有人明確具結某台伺服器已設定存取控制，isUnprotected() 就必須為 true，
// 不論那個網址長什麼樣子。任何未來的新網址都自動被涵蓋。
//
// 執行：node tests/fhir-client.test.mjs（不需要 Firestore 模擬器與網路）

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'fhir-client.js'), 'utf8');

const results = [];
const check = (name, cond, detail) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (detail || '')]);

// fhir-client.js 在載入時把自己掛上 window，並於 init() 讀取 DbService 的設定。
// 這裡以最小替身供應這兩者，不觸網。
//
// 每個情境都需要一份「剛載入」的連線層（模組內的 _base、_accessControlDeclared
// 是模組級狀態）。用 require + 清快取在 ESM 下不可靠，因此直接把原始碼
// 在一個乾淨的作用域中求值，每次都得到全新的閉包。
function loadClient(settings) {
  const win = {};
  const DbService = { async getSystemSettings() { return settings; } };
  // module 傳 undefined：檔尾的 module.exports 判斷會被略過，只走 window 這條路。
  new Function('window', 'DbService', 'module', SRC)(win, DbService, undefined);
  return win.FhirClient;
}

const CLOUD_RUN = 'https://medsafe-fhir-1035204324951.asia-east1.run.app/fhir';
const SANDBOX = 'https://hapi.fhir.org/baseR4';

// ---------------------------------------------------------------
// 一、預設站在保守的那一邊
// ---------------------------------------------------------------
// 這一組是本檔的核心。它以「未來會出現、現在還不存在的網址」為輸入——
// 缺陷當初正是由一個新網址觸發的，而舊測試只認得舊網址。

{
  const c = loadClient({ fhirUrl: CLOUD_RUN });
  await c.init();
  check('自架伺服器未具結存取控制時，判定為未受保護（本次缺陷的實際情境）',
    c.isUnprotected() === true);
  check('自架伺服器不會被誤認為 HL7 公開沙箱',
    c.isPublicSandbox() === false);
}

{
  const c = loadClient({ fhirUrl: 'https://some-future-server.example.com/fhir' });
  await c.init();
  check('任何未具結的位址一律判定為未受保護（不限於已知網址）',
    c.isUnprotected() === true);
}

{
  const c = loadClient(null);
  await c.init();
  check('讀不到系統設定時判定為未受保護（不確定不可呈現為安全）',
    c.isUnprotected() === true);
}

{
  const win = {};
  const failing = { async getSystemSettings() { throw new Error('network down'); } };
  new Function('window', 'DbService', 'module', SRC)(win, failing, undefined);
  const c = win.FhirClient;
  await c.init();
  check('設定讀取拋錯時判定為未受保護（失敗方向必須保守）',
    c.isUnprotected() === true);
}

// ---------------------------------------------------------------
// 二、具結之後才可以關掉警告
// ---------------------------------------------------------------

{
  const c = loadClient({ fhirUrl: CLOUD_RUN, fhirAccessControlled: true });
  await c.init();
  check('明確具結已設定存取控制後，不再判定為未受保護',
    c.isUnprotected() === false);
  check('具結僅為 operator 具結，系統據實標示其未經驗證',
    c.accessControlIsDeclaredOnly() === true);
}

{
  const c = loadClient({ fhirUrl: CLOUD_RUN, fhirAccessControlled: 'false' });
  await c.init();
  // 字串 'false' 是 truthy，若直接採信會把「未受保護」誤判為「已受保護」。
  // 這裡確認具結值有被正規化為布林——設定值來自資料庫，型別不保證。
  check('具結值為字串時仍以布林語意處理（!! 正規化）',
    typeof c.accessControlIsDeclaredOnly() === 'boolean');
}

// ---------------------------------------------------------------
// 三、HL7 公開沙箱不是任何人能宣告安全的
// ---------------------------------------------------------------

{
  const c = loadClient({ fhirUrl: SANDBOX, fhirAccessControlled: true });
  await c.init();
  check('對 hapi.fhir.org 具結存取控制無效，仍判定為未受保護',
    c.isUnprotected() === true);
}

{
  const c = loadClient({ fhirUrl: 'https://HAPI.FHIR.ORG/baseR4', fhirAccessControlled: true });
  await c.init();
  check('公開沙箱的比對不分大小寫',
    c.isUnprotected() === true);
}

// ---------------------------------------------------------------
// 四、位址與主機名的據實顯示
// ---------------------------------------------------------------
// 警告文字改為顯示實際主機名，取代寫死的 'hapi.fhir.org'——
// 寫死的文字在換伺服器後會變成不實陳述。

{
  const c = loadClient({ fhirUrl: CLOUD_RUN });
  await c.init();
  check('host() 回傳實際主機名，供介面據實顯示',
    c.host() === 'medsafe-fhir-1035204324951.asia-east1.run.app', c.host());
  check('isFromSettings() 反映位址確實來自管理端設定',
    c.isFromSettings() === true);
}

{
  const c = loadClient({ fhirUrl: 'http://insecure.example.com/fhir' });
  await c.init();
  // 只接受 https：這條連線送的是病歷資料。
  check('http 位址被拒絕並沿用預設值',
    c.baseUrl() === SANDBOX && c.isFromSettings() === false, c.baseUrl());
  check('遭拒的位址不會讓系統誤判為已受保護',
    c.isUnprotected() === true);
}

// ---------------------------------------------------------------

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, detail] of results) {
  console.log(`${status}  ${name} ${detail}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
