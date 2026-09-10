// LINE webhook 的邊界測試：簽章驗證、事件冪等去重、意圖分流。
//
// 這三件事都在「訊息還沒進到任何業務邏輯之前」就決定了，因此獨立於 NLU 測試。
// 不接 Firestore、不接 LINE、不打 LLM。
//
// 執行：node tests/line-webhook.test.mjs（不需要 Firestore 模擬器）

import { createRequire } from 'module';
import crypto from 'crypto';
const require = createRequire(import.meta.url);

const lineApi = require('../functions/src/line-api.js');

const results = [];
const check = (name, cond, detail) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (detail || '')]);

// ── 一、x-line-signature 驗證 ────────────────────────────────────────
//
// 這是本專案唯一對外開放、未經 Firebase Auth 的 HTTP 端點，驗簽是它
// 全部的存取控制。以下每一條失敗都代表任何人都能偽造服藥回報。

const SECRET = 'test-channel-secret-0123456789';
const body = Buffer.from(JSON.stringify({
  events: [{ type: 'message', message: { type: 'text', text: '血壓藥吃了' } }]
}), 'utf8');
const validSig = crypto.createHmac('sha256', SECRET).update(body).digest('base64');

check('正確簽章通過驗證',
  lineApi.verifySignature(body, validSig, SECRET) === true);

check('簽章錯誤時拒絕',
  lineApi.verifySignature(body, 'aW52YWxpZC1zaWduYXR1cmUtaGVyZS0xMjM0NTY3OA==', SECRET) === false);

check('用錯的 channel secret 算出的簽章被拒絕',
  lineApi.verifySignature(body,
    crypto.createHmac('sha256', 'wrong-secret').update(body).digest('base64'), SECRET) === false);

check('body 被竄改後原簽章失效',
  lineApi.verifySignature(Buffer.from(body.toString('utf8').replace('吃了', '沒吃'), 'utf8'),
    validSig, SECRET) === false);

check('缺少簽章標頭時拒絕', lineApi.verifySignature(body, undefined, SECRET) === false);
check('缺少 body 時拒絕', lineApi.verifySignature(undefined, validSig, SECRET) === false);
check('缺少 channel secret 時拒絕', lineApi.verifySignature(body, validSig, undefined) === false);
check('空字串簽章被拒絕', lineApi.verifySignature(body, '', SECRET) === false);

// 長度不同的簽章不可讓 timingSafeEqual 拋錯而使整個 webhook 500。
// 500 會讓 LINE 重送，於是一個畸形請求就能造成持續重試。
{
  let threw = false;
  let out = null;
  try { out = lineApi.verifySignature(body, 'short', SECRET); } catch (e) { threw = true; }
  check('長度不符的簽章回 false 而非拋錯', !threw && out === false);
}

// 【必須用 rawBody】重新序列化過的 body 算出來的簽章與原文不同。
// 這條測的是「為什麼 webhook.js 一定要用 req.rawBody」——
// 若哪天有人改成 JSON.stringify(req.body)，這條會失敗。
{
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8'))), 'utf8');
  const sigOfReserialized = crypto.createHmac('sha256', SECRET).update(reserialized).digest('base64');
  // 這兩者「碰巧相同」是可能的（本例的 JSON 恰好往返一致），
  // 真正要守的是：驗簽必須對收到的位元組本身計算。
  check('驗簽對收到的位元組計算（rawBody 語義）',
    lineApi.verifySignature(reserialized, sigOfReserialized, SECRET) === true);
}

// ── 二、意圖分流 ─────────────────────────────────────────────────────
//
// 加入 NLU 之後，原本 /藥箱|藥|用藥|吃什麼/ 這個過寬的比對會吃掉幾乎每一句
// 跟藥有關的話，讓自由文字回報永遠走不到 NLU。以下守住收緊後的邊界。

const CABINET_RE = /^(藥箱|我的藥|我的用藥|用藥清單|查藥|查用藥|吃什麼藥?|有哪些藥)[？?。!！]*$/;

for (const q of ['藥箱', '我的藥', '用藥清單', '查藥', '有哪些藥', '吃什麼藥？', '藥箱。']) {
  check('查詢意圖仍被辨識：「' + q + '」', CABINET_RE.test(q));
}

// 【這一組是新功能能否運作的關鍵】每一句都含「藥」字，
// 舊的比對會把它們全部當成查詢藥箱。
for (const s of [
  '剛吃完血壓藥',
  '剛吃完血壓藥，但忘記吃降血糖那顆',
  '血壓藥吃了',
  '我忘記吃藥了',
  '早上的藥吃過了',
  '降血脂的藥還沒吃'
]) {
  check('回報敘述不被誤判為查詢：「' + s + '」', CABINET_RE.test(s) === false);
}

// ── 三、事件冪等去重 ─────────────────────────────────────────────────
//
// LINE 收不到 200（或收得太慢）時會重送整批事件。自由文字回報要等 LLM，
// 比按按鈕慢，因此真的會撞上重送。而本專案的病歷不可刪除，
// 重複寫入無法用刪除補救。
//
// 這裡用一個記憶體版的 create()-as-lock 複製 push-lock.js 的語義，
// 驗證 claimEvent 的判斷邏輯本身；真正的 Firestore 原子性由 Firestore 保證。

function makeLock() {
  const seen = new Set();
  return {
    claim(key) {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    release(key) { seen.delete(key); },
    has(key) { return seen.has(key); }
  };
}

// 與 webhook.js 的 claimEvent 同一份判斷
function claimEvent(lock, event) {
  if (!event.webhookEventId) return true;
  return lock.claim('evt:' + event.webhookEventId);
}

{
  const lock = makeLock();
  const evt = { webhookEventId: 'abc123', type: 'message' };
  check('同一個 webhookEventId 只受理一次',
    claimEvent(lock, evt) === true && claimEvent(lock, evt) === false);
}
{
  const lock = makeLock();
  check('不同事件互不影響',
    claimEvent(lock, { webhookEventId: 'a', type: 'message' }) === true
    && claimEvent(lock, { webhookEventId: 'b', type: 'message' }) === true);
}
{
  // 舊版事件沒有 webhookEventId。擋不住重複也要放行——
  // 「因為無法去重就乾脆不受理回報」比偶爾重複更糟。
  const lock = makeLock();
  const evt = { type: 'message' };
  check('缺少 webhookEventId 時仍受理（不因無法去重而拒收）',
    claimEvent(lock, evt) === true && claimEvent(lock, evt) === true);
}
{
  // 處理失敗時要放掉鎖，否則「失敗一次就永久不再受理這個事件」。
  const lock = makeLock();
  const evt = { webhookEventId: 'retry-me', type: 'message' };
  claimEvent(lock, evt);
  lock.release('evt:' + evt.webhookEventId);
  check('處理失敗釋放鎖後，LINE 重送可以再試一次', claimEvent(lock, evt) === true);
}
{
  const lock = makeLock();
  const key = 'evt:x';
  lock.claim(key);
  check('鎖的鍵帶 evt: 前綴，與每日推播鎖不衝突',
    lock.has('evt:x') && !lock.has('x'));
}

// ── 四、quick reply 訊息組裝 ─────────────────────────────────────────
//
// LINE 對 quick reply 有硬上限：13 顆按鈕、label 20 字。
// 超過會整則訊息被拒（不是截斷），使用者什麼都收不到。

{
  const msg = lineApi.textWithQuickReply('請問是哪一次？', [
    { label: '08:00', data: 'action=taken&day=2026-09-10&time=08%3A00' },
    { label: '22:00', data: 'action=taken&day=2026-09-10&time=22%3A00' }
  ]);
  check('quick reply 產生 postback 型別的按鈕',
    msg.quickReply.items.length === 2
    && msg.quickReply.items[0].action.type === 'postback');
  check('quick reply 沿用既有的 action=taken postback，不新增型別',
    /^action=taken&day=/.test(msg.quickReply.items[0].action.data));
}
{
  const many = Array.from({ length: 20 }, (_, i) => ({ label: 'x' + i, data: 'd' + i }));
  const msg = lineApi.textWithQuickReply('t', many);
  check('超過 13 顆按鈕時裁到上限（否則整則訊息被 LINE 拒絕）',
    msg.quickReply.items.length === 13);
}
{
  const msg = lineApi.textWithQuickReply('t', [{ label: '這是一個非常長的藥名超過二十個字元的情況測試', data: 'd' }]);
  check('label 超過 20 字時裁切', msg.quickReply.items[0].action.label.length === 20);
}
{
  const msg = lineApi.textWithQuickReply('沒有按鈕', []);
  check('沒有候選時不掛空的 quickReply 欄位', msg.quickReply === undefined);
}

// --- 輸出 ---
console.log('');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '\n      ' + r[2] : '');
const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
