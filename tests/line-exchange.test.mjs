// LIFF 身分橋接（lineExchangeToken）的邊界測試：只測 extractLineUserId，
// 這是「LINE verify 回應 → 可信的 lineUserId」唯一會做判斷的地方。
// 不打網路、不接 Firestore、不接 Firebase Admin。
//
// 執行：node tests/line-exchange.test.mjs

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { _internal } = require('../functions/src/exchange.js');
const { extractLineUserId, validateUsername } = _internal;

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

// access token 備援路徑（ID Token 過期時才使用，見 exchange.js resolveLineUserId）。
// 與 aud 檢查同等級的不可退讓：別的 channel 核發的 access token 一樣拿得到 profile。
const { assertAccessTokenForChannel, extractProfileUserId } = _internal;

check('access token：本 channel 且未過期時通過',
  !throws(() => assertAccessTokenForChannel({ client_id: CHANNEL_ID, expires_in: 2591000, scope: 'openid profile' }, CHANNEL_ID)));

check('access token：client_id 為數字型別仍能與字串 channel ID 比對',
  !throws(() => assertAccessTokenForChannel({ client_id: Number(CHANNEL_ID), expires_in: 100 }, CHANNEL_ID)));

check('access token：client_id 不符時拒絕',
  !!throws(() => assertAccessTokenForChannel({ client_id: 'someone-elses-channel', expires_in: 2591000 }, CHANNEL_ID)));

check('access token：缺少 client_id 時拒絕',
  !!throws(() => assertAccessTokenForChannel({ expires_in: 2591000 }, CHANNEL_ID)));

{
  const e = throws(() => assertAccessTokenForChannel({ client_id: CHANNEL_ID, expires_in: 0 }, CHANNEL_ID));
  check('access token：expires_in 為 0 時拒絕，且錯誤訊息含 expired（前端才會自動重登一次）',
    !!e && /expired/i.test(e.message));
}

check('access token：缺少 expires_in 時拒絕',
  !!throws(() => assertAccessTokenForChannel({ client_id: CHANNEL_ID }, CHANNEL_ID)));

check('access token：未設定 channel ID 時一律拒絕（即使 client_id 也是空字串）',
  !!throws(() => assertAccessTokenForChannel({ client_id: '', expires_in: 100 }, '')));

check('profile：回傳 userId', extractProfileUserId({ userId: 'U0123456789abcdef', displayName: 'x' }) === 'U0123456789abcdef');
check('profile：缺少 userId 時拒絕', !!throws(() => extractProfileUserId({ displayName: 'x' })));

// validateUsername：lineRegisterPatient（首次用 LINE 登入的自助註冊）用的
// 規則，刻意與 login.html 的 register()、firestore.rules 的
// isSelfRegisteringPatient 保持同一組規則——這裡測的是「這份重新抄寫的
// 規則本身有沒有抄對」，不是在測三處是否真的同步（那需要跑 login.html
// 或 firestore.rules，不是這支純 Node 測試的範圍）。

check('合法帳號通過', validateUsername('patient_01') === null);

check('太短的帳號被拒絕', validateUsername('ab') === '帳號限英數字、底線與句點，長度 3-20');

check('含大寫字母的帳號被拒絕',
  validateUsername('Patient01') === '帳號限英數字、底線與句點，長度 3-20');

check('含不允許符號的帳號被拒絕',
  validateUsername('patient@01') === '帳號限英數字、底線與句點，長度 3-20');

// 身分證字號格式：首碼英文字母 + 1/2/8/9 + 8 碼數字。
check('身分證字號格式的帳號被拒絕',
  validateUsername('a123456789') === '帳號不可使用身分證字號格式，請另外設定帳號');

check('新式居留證號格式（第2碼為8/9）的帳號被拒絕',
  validateUsername('a823456789') === '帳號不可使用身分證字號格式，請另外設定帳號');

check('第2碼不是1/2/8/9 時不會被誤判為身分證字號格式',
  validateUsername('a323456789') === null);

check('非字串輸入被拒絕', validateUsername(undefined) === '帳號格式錯誤');

// ── resolveLineUserId 的分流：只有「ID Token 過期」才改走 access token ──
// 以替換 https.request 的方式模擬 LINE API（exchange.js 在呼叫當下才讀
// https.request，因此替換同一個 module 物件即可生效），不打真的網路。
{
  const https = require('https');
  const { EventEmitter } = require('events');
  const realRequest = https.request;
  const { resolveLineUserId } = _internal;

  function mockLine(routes) {
    const calls = [];
    https.request = (url, opts, cb) => {
      const key = (opts.method || 'GET') + ' ' + String(url).split('?')[0];
      calls.push(key);
      const [status, body] = routes[key] || [500, { error: 'unmocked ' + key }];
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = status;
        cb(res);
        res.emit('data', JSON.stringify(body));
        res.emit('end');
      };
      return req;
    };
    return calls;
  }
  const VERIFY = 'https://api.line.me/oauth2/v2.1/verify';
  const PROFILE = 'https://api.line.me/v2/profile';

  try {
    // 1. ID Token 有效：不碰 access token
    let calls = mockLine({ ['POST ' + VERIFY]: [200, { aud: CHANNEL_ID, sub: 'U_ID' }] });
    let uid = await resolveLineUserId({ idToken: 'id', accessToken: 'at' }, CHANNEL_ID);
    check('ID Token 有效時直接回傳 sub，不呼叫 access token 驗證',
      uid === 'U_ID' && calls.length === 1, JSON.stringify(calls));

    // 2. ID Token 過期 + access token 有效：改走 access token
    calls = mockLine({
      ['POST ' + VERIFY]: [400, { error: 'invalid_request', error_description: 'IdToken expired.' }],
      ['GET ' + VERIFY]: [200, { client_id: CHANNEL_ID, expires_in: 2591000, scope: 'openid profile' }],
      ['GET ' + PROFILE]: [200, { userId: 'U_AT', displayName: 'x' }]
    });
    uid = await resolveLineUserId({ idToken: 'id', accessToken: 'at' }, CHANNEL_ID);
    check('ID Token 過期時改用 access token 取得 userId', uid === 'U_AT', JSON.stringify(calls));

    // 3. ID Token 過期 + access token 屬於別的 channel：拒絕，且不去拿 profile
    calls = mockLine({
      ['POST ' + VERIFY]: [400, { error: 'invalid_request', error_description: 'IdToken expired.' }],
      ['GET ' + VERIFY]: [200, { client_id: 'someone-elses-channel', expires_in: 2591000 }],
      ['GET ' + PROFILE]: [200, { userId: 'U_ATTACKER' }]
    });
    let err = null;
    try { await resolveLineUserId({ idToken: 'id', accessToken: 'at' }, CHANNEL_ID); } catch (e) { err = e; }
    check('備援路徑：別的 channel 的 access token 被拒絕，且不呼叫 profile',
      !!err && !calls.includes('GET ' + PROFILE), JSON.stringify(calls));

    // 4. ID Token aud 不符（不是過期）：不可改走 access token 把設定錯誤藏起來
    calls = mockLine({
      ['POST ' + VERIFY]: [200, { aud: 'someone-elses-channel', sub: 'U_X' }],
      ['GET ' + VERIFY]: [200, { client_id: CHANNEL_ID, expires_in: 2591000 }],
      ['GET ' + PROFILE]: [200, { userId: 'U_AT' }]
    });
    err = null;
    try { await resolveLineUserId({ idToken: 'id', accessToken: 'at' }, CHANNEL_ID); } catch (e) { err = e; }
    check('ID Token aud 不符時直接拒絕，不改走 access token',
      !!err && calls.length === 1, JSON.stringify(calls));

    // 5. ID Token 過期但前端沒送 access token（舊版前端快取）：維持原本的 expired 錯誤
    calls = mockLine({ ['POST ' + VERIFY]: [400, { error_description: 'IdToken expired.' }] });
    err = null;
    try { await resolveLineUserId({ idToken: 'id' }, CHANNEL_ID); } catch (e) { err = e; }
    check('沒有 access token 時維持 expired 錯誤（前端才會自動重登一次）',
      !!err && /expired/i.test(err.message));
  } finally {
    https.request = realRequest;
  }
}

// ── assertIsFriend：登入前的好友門檻（見 exchange.js 該函式的長註解）──
// 以替換 line-api.js 的 getProfile 來模擬 LINE Messaging API 的三種回應，
// 不打真的網路——與上面替換 https.request 同一個理由（同一個模組物件，
// exchange.js require 進來的是同一份 exports）。
{
  const lineApi = require('../functions/src/line-api.js');
  const { assertIsFriend } = _internal;
  const realGetProfile = lineApi.getProfile;

  try {
    // 1. 是好友（profile 查得到）：不拋錯
    lineApi.getProfile = async () => ({ userId: 'U_FRIEND' });
    let err = null;
    try { await assertIsFriend('U_FRIEND'); } catch (e) { err = e; }
    check('已加好友時不拋錯，登入可以繼續', err === null);

    // 2. 不是好友／已封鎖（profile 404 → getProfile 回 null）：拋出帶
    //    notFriend:true 的 failed-precondition，且 addFriendUrl 由
    //    LINE_BASIC_ID 組出
    process.env.LINE_BASIC_ID = '@testid';
    lineApi.getProfile = async () => null;
    err = null;
    try { await assertIsFriend('U_NOT_FRIEND'); } catch (e) { err = e; }
    check('未加好友時拋出 failed-precondition 且帶 notFriend:true',
      !!err && err.code === 'failed-precondition' && err.details && err.details.notFriend === true);
    check('未加好友時的錯誤帶著由 LINE_BASIC_ID 組出的 addFriendUrl',
      !!err && err.details.addFriendUrl === 'https://line.me/R/ti/p/%40testid');
    delete process.env.LINE_BASIC_ID;

    // 3. LINE_BASIC_ID 未設定時：不給一個開不了的連結（null 而非組出畸形網址）
    lineApi.getProfile = async () => null;
    err = null;
    try { await assertIsFriend('U_NOT_FRIEND'); } catch (e) { err = e; }
    check('LINE_BASIC_ID 未設定時，addFriendUrl 為 null 而非畸形網址',
      !!err && err.details.addFriendUrl === null);

    // 4. 查詢本身失敗（LINE API 打不通/逾時）：暫時放行（fail-open），
    //    不可讓第三方 API 短暫不穩定擋下所有人的登入——見 assertIsFriend 註解。
    lineApi.getProfile = async () => { throw new Error('LINE API 逾時'); };
    err = null;
    try { await assertIsFriend('U_UNKNOWN'); } catch (e) { err = e; }
    check('好友狀態查詢本身失敗時暫時放行（fail-open），不擋登入', err === null);
  } finally {
    lineApi.getProfile = realGetProfile;
  }
}

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, detail] of results) {
  console.log(`${status === 'PASS' ? '✅' : '❌'} ${name}${detail ? '  (' + detail + ')' : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
if (failed.length) process.exit(1);
