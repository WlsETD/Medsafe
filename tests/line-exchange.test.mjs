// LIFF 身分橋接（lineExchangeToken）的邊界測試：只測 extractLineUserId，
// 這是「LINE verify 回應 → 可信的 lineUserId」唯一會做判斷的地方。
// 不打網路、不接 Firestore、不接 Firebase Admin。
//
// 執行：node tests/line-exchange.test.mjs

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { _internal } = require('../functions/src/exchange.js');
const { extractLineUserId } = _internal;

const results = [];
const check = (name, cond, detail) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (detail || '')]);

const CHANNEL_ID = '1234567890';

function throws(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

check('正確 aud/sub 通過並回傳 sub',
  extractLineUserId({ aud: CHANNEL_ID, sub: 'U0123456789abcdef' }, CHANNEL_ID) === 'U0123456789abcdef');

// 【不可退讓】aud 不符——別的 LINE Login channel 核發的 token 不能拿來換這裡的身分
check('aud 不符時拒絕',
  !!throws(() => extractLineUserId({ aud: 'someone-elses-channel', sub: 'Uattacker' }, CHANNEL_ID)));

check('缺少 aud 時拒絕',
  !!throws(() => extractLineUserId({ sub: 'U0123456789abcdef' }, CHANNEL_ID)));

check('缺少 sub 時拒絕',
  !!throws(() => extractLineUserId({ aud: CHANNEL_ID }, CHANNEL_ID)));

check('sub 為空字串時拒絕',
  !!throws(() => extractLineUserId({ aud: CHANNEL_ID, sub: '' }, CHANNEL_ID)));

check('verify 回應不是物件時拒絕',
  !!throws(() => extractLineUserId(null, CHANNEL_ID)));

// 【不可退讓】未設定 LINE_LOGIN_CHANNEL_ID 時（空字串）一律拒絕，
// 不可以把「未設定」誤判成「跟任何 aud 都相符」。
check('expectedChannelId 為空字串時一律拒絕（即使 aud 也是空字串）',
  !!throws(() => extractLineUserId({ aud: '', sub: 'U0123456789abcdef' }, '')));

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, detail] of results) {
  console.log(`${status === 'PASS' ? '✅' : '❌'} ${name}${detail ? '  (' + detail + ')' : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
if (failed.length) process.exit(1);
