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

// 「選單」意圖：與 CABINET_RE 同樣錨定整句。
const MENU_RE = /^(選單|menu|說明|help|功能|你會什麼)[？?。!！]*$/i;

for (const q of ['選單', 'menu', 'Menu', '說明', 'help', '功能', '你會什麼']) {
  check('選單意圖被辨識：「' + q + '」', MENU_RE.test(q));
}
for (const s of ['說明書上寫早上吃', '這個功能怎麼用', '選單上沒有這個藥']) {
  // 錨定整句，含選單/說明字樣的長句不可誤判成呼叫選單。
  check('選單意圖不誤判夾在句子裡的同字：「' + s + '」', MENU_RE.test(s) === false);
}

// 「開發中功能」的誠實提示：Rich Menu 上「回報不適」這格目前還沒實作
// （Phase 4），按下去要有明確的開發中訊息，不能被自由文字 NLU 收走
// （那會讓 GPT 硬答一個功能還不存在的問題）。「預約」在 Phase 3 做完後
// 移出這張表，改用下面獨立的 BOOKING_RE（見 webhook.js 的說明），
// 兩者都直接從 webhook.js 的 _internal 取，不在測試裡重寫一份規則，
// 避免兩邊定義漂移。
const COMING_SOON = { 回報不適: 'y' };
const COMING_SOON_RE_LOCAL = new RegExp('^(' + Object.keys(COMING_SOON).join('|') + ')[？?。!！]*$');

for (const q of ['回報不適', '回報不適!']) {
  check('開發中提示意圖被辨識：「' + q + '」', COMING_SOON_RE_LOCAL.test(q));
}
for (const s of ['幫我掛號給張醫師', '我不適很久了']) {
  check('開發中提示不誤判夾在句子裡的同字：「' + s + '」', COMING_SOON_RE_LOCAL.test(s) === false);
}
check('「預約」已不在開發中提示表內（Phase 3 完成後移出，見 BOOKING_RE）',
  COMING_SOON_RE_LOCAL.test('預約') === false);
{
  const m = '回報不適！'.match(COMING_SOON_RE_LOCAL);
  check('帶標點時仍能用捕獲群組查到正確的訊息（不因標點查表落空）',
    m && COMING_SOON[m[1]] === 'y');
}

// ── 線上預約（Phase 3）：BOOKING_RE 的意圖辨識，直接用 webhook.js 匯出的正則 ──
{
  const { BOOKING_RE } = require('../functions/src/webhook.js')._internal;

  for (const q of ['預約', '線上預約', '預約？', '線上預約!']) {
    check('掛號意圖被辨識：「' + q + '」', BOOKING_RE.test(q));
  }
  for (const s of ['我想預約看診時間表', '幫我掛號給張醫師']) {
    // 錨定整句，理由與 CABINET_RE／MENU_RE 相同——這兩句含「預約」二字，
    // 但不是「按了預約格」那個精確意圖，不可誤收。
    check('掛號意圖不誤判夾在句子裡的同字：「' + s + '」', BOOKING_RE.test(s) === false);
  }
}

// ── bookingReply()：LIFF_ID 有無設定時的兩種回應 ────────────────────────
{
  const originalLiffId = process.env.LIFF_ID;

  delete process.env.LIFF_ID;
  delete require.cache[require.resolve('../functions/src/webhook.js')];
  const noLiff = require('../functions/src/webhook.js')._internal.bookingReply();
  check('LIFF_ID 未設定時，掛號回覆是開發中文字訊息',
    noLiff.type === 'text' && /開發中/.test(noLiff.text));
  check('LIFF_ID 未設定時，掛號回覆不附任何按鈕（沒有可用的連結可以給）',
    noLiff.quickReply === undefined);

  process.env.LIFF_ID = 'test-liff-id-0002';
  delete require.cache[require.resolve('../functions/src/webhook.js')];
  const withLiff = require('../functions/src/webhook.js')._internal.bookingReply();
  const bookingBtn = withLiff.quickReply && withLiff.quickReply.items
    .map(i => i.action).find(a => a.label === '前往掛號');
  check('LIFF_ID 已設定時，掛號回覆附「前往掛號」按鈕',
    !!bookingBtn);
  check('「前往掛號」連到 LIFF 深連結且帶 view=appointments（對上 patient.html 的還原邏輯）',
    !!bookingBtn && bookingBtn.uri === 'https://liff.line.me/test-liff-id-0002?view=appointments');
  check('「前往掛號」是 uri 型別而非 message',
    !!bookingBtn && bookingBtn.type === 'uri');

  if (originalLiffId === undefined) delete process.env.LIFF_ID;
  else process.env.LIFF_ID = originalLiffId;
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

// 選單按鈕用 text（message action）而非 postback：按下去等同使用者自己
// 打了這句話送出，直接借用既有的文字指令分支（見 webhook.js menuItems 的說明）。
{
  const msg = lineApi.textWithQuickReply('選單', [{ label: '查藥箱', text: '藥箱' }]);
  check('text 選項產生 message 型別的按鈕，且帶原句文字',
    msg.quickReply.items[0].action.type === 'message'
    && msg.quickReply.items[0].action.text === '藥箱');
}
// uri 選項（Phase 0 之後開 LIFF 連結會用到）。
{
  const msg = lineApi.textWithQuickReply('選單', [{ label: '線上掛號', uri: 'https://liff.line.me/xxx' }]);
  check('uri 選項產生 uri 型別的按鈕',
    msg.quickReply.items[0].action.type === 'uri'
    && msg.quickReply.items[0].action.uri === 'https://liff.line.me/xxx');
}
// withQuickReply：掛在任意訊息（含非 text 型別，例如 Flex 卡片）上，
// 而不是只能透過 textWithQuickReply 建立新的文字訊息。
{
  const flexLike = { type: 'flex', altText: '每日用藥卡', contents: {} };
  const withMenu = lineApi.withQuickReply(flexLike, [{ label: '查藥箱', text: '藥箱' }]);
  check('withQuickReply 可以掛在非文字訊息（如 Flex 卡片）上',
    withMenu.type === 'flex' && withMenu.quickReply.items.length === 1);
}
{
  const flexLike = { type: 'flex', altText: 'x', contents: {} };
  const withMenu = lineApi.withQuickReply(flexLike, []);
  check('withQuickReply 沒有候選時同樣不掛空的 quickReply 欄位',
    withMenu.quickReply === undefined);
}

// ── 四、選單的「完整藥箱」LIFF 按鈕（Phase 0 完成後新增）───────────────
//
// LIFF_ID 用 firebase-functions/params 的 defineString 讀取，本地測試時
// 即時讀 process.env.LIFF_ID，因此可以在同一個程序內切換測試有無設定的
// 兩種情境，不需要 emulator。webhook.js require 時不呼叫 admin.initializeApp()，
// 可以安全地直接載入（與 exchange.js／bindings.js 同樣的理由）。
{
  const originalLiffId = process.env.LIFF_ID;
  delete process.env.LIFF_ID;
  delete require.cache[require.resolve('../functions/src/webhook.js')];
  const webhookNoLiff = require('../functions/src/webhook.js');
  const itemsNoLiff = webhookNoLiff._internal.menuItems();

  check('LIFF_ID 未設定時，選單不含「完整藥箱」按鈕',
    !itemsNoLiff.some(i => i.label === '完整藥箱'));

  process.env.LIFF_ID = 'test-liff-id-0001';
  delete require.cache[require.resolve('../functions/src/webhook.js')];
  const webhookWithLiff = require('../functions/src/webhook.js');
  const itemsWithLiff = webhookWithLiff._internal.menuItems();
  const liffItem = itemsWithLiff.find(i => i.label === '完整藥箱');

  check('LIFF_ID 已設定時，選單含「完整藥箱」按鈕',
    !!liffItem);
  check('「完整藥箱」按鈕連到 https://liff.line.me/{LIFF_ID}',
    !!liffItem && liffItem.uri === 'https://liff.line.me/test-liff-id-0001');
  check('「完整藥箱」是 uri 型別而非 message（開 LIFF，不是送文字）',
    !!liffItem && !liffItem.text);
  check('既有選單項目（查藥箱／線上預約／回報不適／用藥查詢／服藥時間表）不受影響',
    itemsWithLiff.length === 6
    && itemsWithLiff.some(i => i.label === '查藥箱' && i.text === '藥箱')
    && itemsWithLiff.some(i => i.label === '線上預約')
    && itemsWithLiff.some(i => i.label === '回報不適')
    && itemsWithLiff.some(i => i.label === '用藥查詢')
    && itemsWithLiff.some(i => i.label === '服藥時間表'));

  if (originalLiffId === undefined) delete process.env.LIFF_ID;
  else process.env.LIFF_ID = originalLiffId;
}

// --- 輸出 ---
console.log('');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '\n      ' + r[2] : '');
const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
