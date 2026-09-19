// LIFF 身分橋接（Phase 0）：LINE ID Token → Firebase Custom Token。
//
// 這支 Function 是 linebot.md §2 講的「身分橋接」的伺服器端一半。它刻意
// 只做一件事：把「這是哪個已驗證的 LINE 帳號」換成「這是哪個已綁定的
// Firebase 使用者」，然後就結束了——換到 Custom Token 之後，前端用
// signInWithCustomToken 登入，接下來就是一個正常的 Firebase Auth
// session，firestore.rules 照常生效，不需要、也不應該在這裡多做任何事。
//
// 【官方明文要求，不可省略】前端 liff.getUserId()／liff.getProfile() 拿到
// 的 userId 不可信任、不可直接送給後端；必須送 liff.getIDToken() 由伺服器
// 呼叫 LINE 的 POST https://api.line.me/oauth2/v2.1/verify 驗證，
// 見 linebot.md 附錄的官方文件連結。
//
// 【為什麼還要比對 aud】verify 端點驗證的是「這個 ID Token 是不是 LINE
// 簽發的」，不是「是不是簽給我們的」。若不檢查 aud，任何一個其他服務的
// LINE Login（甚至別人隨手申請的 demo channel）核發給使用者的 ID Token，
// 都能拿來這裡換發本專案的 Custom Token——因為它們一樣通得過 LINE 的簽章
// 驗證。aud 必須等於本專案自己的 LINE Login channel ID。

const admin = require('firebase-admin');
const https = require('https');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');

const { REGION, LINE_LOGIN_CHANNEL_ID, LINE_CHANNEL_ACCESS_TOKEN, LINE_BASIC_ID } = require('./config');
const bindings = require('./bindings');
const lineApi = require('./line-api');

function verifyIdToken(idToken, channelId) {
  const body = new URLSearchParams({ id_token: idToken, client_id: channelId }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch (e) {
          logger.warn('LINE verify 回應解析失敗', { statusCode: res.statusCode, rawData: data.slice(0, 200) });
          return reject(new Error('LINE verify 回應非 JSON'));
        }
        if (res.statusCode !== 200) {
          logger.warn('LINE verify 回應 ' + res.statusCode, { error: json.error, error_description: json.error_description });
          return reject(new Error(json.error_description || json.error || 'LINE verify 回應 ' + res.statusCode));
        }
        resolve(json);
      });
    });
    req.on('error', (e) => {
      logger.error('LINE verify 網路請求失敗', { message: e.message });
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

function lineGetJson(url, bearer) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: bearer ? { Authorization: 'Bearer ' + bearer } : {}
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch (e) {
          logger.warn('LINE API 回應解析失敗', { url: url.split('?')[0], statusCode: res.statusCode });
          return reject(new Error('LINE verify 回應非 JSON'));
        }
        if (res.statusCode !== 200) {
          logger.warn('LINE API 回應 ' + res.statusCode, { url: url.split('?')[0], error: json.error, error_description: json.error_description, message: json.message });
          return reject(new Error(json.error_description || json.message || json.error || 'LINE verify 回應 ' + res.statusCode));
        }
        resolve(json);
      });
    });
    req.on('error', (e) => {
      logger.error('LINE API 網路請求失敗', { message: e.message });
      reject(e);
    });
    req.end();
  });
}

// 純函式：access token 的 verify 回應是否為「本 channel 核發、尚未過期」。
// 與 extractLineUserId 的 aud 檢查同一個理由——verify 端點只證明 token 是
// LINE 發的，不證明是發給我們的；不比對 client_id，別的 channel 的 access
// token 一樣拿得到 profile，就能換發本專案的身分。
function assertAccessTokenForChannel(verified, expectedChannelId) {
  if (!verified || typeof verified !== 'object') {
    throw new Error('verify 回應格式錯誤');
  }
  if (!expectedChannelId) {
    throw new Error('LINE_LOGIN_CHANNEL_ID 未設定');
  }
  if (String(verified.client_id) !== String(expectedChannelId)) {
    throw new Error('aud（client_id）與預期的 LINE Login channel 不符');
  }
  if (!(Number(verified.expires_in) > 0)) {
    throw new Error('access token expired');
  }
}

function extractProfileUserId(profile) {
  if (!profile || typeof profile.userId !== 'string' || !profile.userId) {
    throw new Error('profile 回應缺少 userId');
  }
  return profile.userId;
}

// 由前端送來的 LIFF 憑證解出可信的 lineUserId。
//
// 【實測踩過的坑】外部瀏覽器（login.html 的「使用 LINE 登入」）裡，LIFF SDK 的
// liff.getIDToken() 會回傳快取住的舊 ID Token——即使剛走完 liff.login() 的
// code/state 重導也一樣（實測過期 68 分鐘，見 js/liff-bridge.js 的說明）。
// 重新登入一次不保證拿到新的，使用者就卡在「LINE 登入已逾時」。
//
// ID Token 的效期很短，access token 則約 30 天，同一次登入核發、不吃這個快取問題。
// 因此 ID Token 仍是主要路徑（行為與先前完全相同），只有在它「過期」時才改用
// access token：GET /oauth2/v2.1/verify 確認 client_id 是本 channel 且未過期，
// 再用同一個 token 呼叫 GET /v2/profile 取得 userId——這是 LINE 官方文件
// 「在伺服器端使用 LIFF 使用者資料」的做法，userId 來自 LINE 伺服器，
// 不是前端宣稱的值，信任強度與驗 ID Token 相同。
// 其他驗證失敗（aud 不符、服務打不通）不改走 access token——那些不是過期問題，
// 換一種憑證只會把真正的設定錯誤藏起來。
async function resolveLineUserId({ idToken, accessToken }, channelId) {
  try {
    const verified = await verifyIdToken(idToken, channelId);
    return extractLineUserId(verified, channelId);
  } catch (e) {
    const expired = !!(e.message && /expired/i.test(e.message));
    if (!expired || typeof accessToken !== 'string' || !accessToken) throw e;
    logger.info('ID Token 已過期，改以 access token 驗證');
    const verifiedAt = await lineGetJson(
      'https://api.line.me/oauth2/v2.1/verify?access_token=' + encodeURIComponent(accessToken));
    assertAccessTokenForChannel(verifiedAt, channelId);
    const profile = await lineGetJson('https://api.line.me/v2/profile', accessToken);
    return extractProfileUserId(profile);
  }
}

// 純函式、不含 I/O，故可離線測試（tests/line-exchange.test.mjs）。
// 抽出來的理由與 line-api.js 的 verifySignature 一樣：這一段判斷錯了，
// 整個身分橋接的信任邊界就沒有意義，值得獨立驗證每一種錯誤輸入。
function extractLineUserId(verified, expectedChannelId) {
  if (!verified || typeof verified !== 'object') {
    throw new Error('verify 回應格式錯誤');
  }
  if (!expectedChannelId) {
    throw new Error('LINE_LOGIN_CHANNEL_ID 未設定');
  }
  if (verified.aud !== expectedChannelId) {
    throw new Error('aud 與預期的 LINE Login channel 不符');
  }
  if (typeof verified.sub !== 'string' || !verified.sub) {
    throw new Error('verify 回應缺少 sub');
  }
  return verified.sub;
}

// 好友門檻：LINE 登入（LIFF）跟「加官方帳號好友」本來是兩件互不相關的
// LINE 功能——光靠 LIFF Login 就能拿到 ID Token，不需要先加好友。但這個
// 系統的核心價值（每日用藥提醒、交互作用警示）全部靠 push／reply 送到
// LINE，沒加好友就永遠收不到，等於註冊了一個看起來成功、實際上什麼都
// 做不了的帳號。因此在換發 Custom Token（登入）與首次自助註冊這兩個
// 入口都擋一次，而不是留給使用者自己發現「怎麼都沒收到提醒」。
//
// 只能用 LINE 的 Messaging API 問，不能信任前端的 liff.getFriendship()——
// 這是一個純靜態前端，任何前端檢查都能被改過的網頁繞過（同一個理由，
// CLAUDE.md 講得很清楚：firestore.rules 才是唯一的信任邊界，這裡的
// 信任邊界換成「LINE 自己的伺服器怎麼回答」）。
//
// 【查不到好友狀態時為什麼放行，不是擋下】
// 這支查詢本身依賴 LINE 的 Messaging API，跟登入流程原本依賴的 LINE
// Login／ID Token 驗證是不同的服務。讓一個第三方 API 的短暫不穩定，
// 直接讓所有人（包含已經加好友多年的老病患）登入不了，風險遠大於
// 誤放行幾個沒加好友的人——沒加好友的人本來就收不到提醒，這條規則
// 真正要防的後果本來就不會因為放行而發生，只是慢了一步被使用者自己
// 發現而已。查詢失敗因此只記 log，不阻擋登入。
async function assertIsFriend(lineUserId) {
  let profile;
  try {
    profile = await lineApi.getProfile(lineUserId, LINE_CHANNEL_ACCESS_TOKEN.value());
  } catch (e) {
    logger.error('好友狀態查詢失敗，暫時視為已加好友以避免登入功能整個中斷', { lineUserId, error: e.message });
    return;
  }
  if (profile === null) {
    const basicId = LINE_BASIC_ID.value();
    throw new HttpsError('failed-precondition', '請先將 MedSafe 加為 LINE 官方帳號好友，才能使用 LINE 登入', {
      notFriend: true,
      addFriendUrl: basicId ? 'https://line.me/R/ti/p/' + encodeURIComponent(basicId) : null
    });
  }
}

// 與 login.html 的 register()、firestore.rules 的 isSelfRegisteringPatient
// 用同一組規則，三處必須保持同步（見 patientInitialDocIsClean 附近的說明）。
// 這裡要重新寫一份而不是共用同一支程式碼，是因為前端規則活在瀏覽器全域
// script、後端活在 Cloud Functions 的 CommonJS module，本專案沒有共用
// 前後端程式碼的建置流程（CLAUDE.md：no bundler, no transpiler）。
const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;
const NATIONAL_ID_SHAPE_RE = /^[a-z][1289][0-9]{8}$/;

function validateUsername(username) {
  if (typeof username !== 'string') return '帳號格式錯誤';
  if (!USERNAME_RE.test(username)) return '帳號限英數字、底線與句點，長度 3-20';
  if (NATIONAL_ID_SHAPE_RE.test(username)) return '帳號不可使用身分證字號格式，請另外設定帳號';
  return null;
}

exports.lineExchangeToken = onCall({ region: REGION, secrets: [LINE_CHANNEL_ACCESS_TOKEN] }, async (request) => {
  const idToken = request.data && request.data.idToken;
  if (typeof idToken !== 'string' || !idToken) {
    throw new HttpsError('invalid-argument', '缺少 idToken');
  }

  const channelId = LINE_LOGIN_CHANNEL_ID.value();
  if (!channelId) {
    // 尚未設定 LIFF 用的 LINE Login channel ID：功能刻意關閉，
    // 不是錯誤——見 config.js 的說明。
    throw new HttpsError('failed-precondition', 'LIFF 尚未設定完成，請聯絡管理員');
  }

  let lineUserId;
  try {
    lineUserId = await resolveLineUserId({ idToken, accessToken: request.data.accessToken }, channelId);
  } catch (e) {
    logger.warn('LINE ID Token 驗證失敗', { message: e.message, code: e.code });
    // 區分不同的驗證失敗原因，讓前端和管理員有更清楚的故障排查線索。
    // 「expired」這個 details 欄位是特地給 js/liff-bridge.js 用的：過期的
    // token 是唯一「使用者重新登入一次就能自行解決」的情況，其餘原因
    // （channel 設定不符、verify 服務打不通）重新登入也沒用，不能讓前端
    // 對這些狀況也自動重登，否則會卡進無限重導迴圈（liff-bridge.js 有
    // 記一次踩過的教訓）。
    const expired = !!(e.message && /expired/i.test(e.message));
    let detailMsg = 'LINE 登入驗證失敗，請重新開啟 LIFF';
    if (expired) {
      detailMsg = 'LINE 登入已逾時，請重新登入';
    } else if (e.message && e.message.includes('LINE verify')) {
      detailMsg = 'LINE verify 服務暫時無法連接，請稍後再試';
    } else if (e.message && e.message.includes('aud')) {
      detailMsg = 'LINE Login channel 設定不符，請聯絡管理員';
    } else if (e.message && e.message.includes('未設定')) {
      detailMsg = 'LIFF 尚未完全設定，請聯絡管理員';
    }
    throw new HttpsError('unauthenticated', detailMsg, { expired });
  }

  await assertIsFriend(lineUserId);

  // line_users 是唯一的 lineUserId → uid 反向索引，且解除綁定時會被刪除
  // （見 bindings.js 的說明）——因此「查不到」與「已解除綁定」是同一件事，
  // 兩者都應該得到同一個「請先完成綁定」的結果，不需要也不應該區分。
  const link = await bindings.findByLineUserId(lineUserId);
  if (!link || !link.uid) {
    throw new HttpsError('failed-precondition', '尚未綁定 LINE，請先在網頁版完成綁定');
  }

  let customToken;
  try {
    customToken = await admin.auth().createCustomToken(link.uid);
  } catch (e) {
    // 最常見的原因：Cloud Functions 執行用的服務帳戶缺少
    // 「Service Account Token Creator」角色——createCustomToken 內部要呼叫
    // IAM 的 signBlob，沒有這個角色會拋 auth/insufficient-permission，
    // 訊息本身不會說「請去 IAM 加角色」，容易被誤認成別的問題（例如誤以為
    // 是綁定沒成功）。這裡明確記下來，不要讓它變成前端看到的泛用 internal 錯誤。
    logger.error('createCustomToken 失敗', { username: link.username, code: e.code, message: e.message });
    throw new HttpsError('internal', '系統換發登入憑證失敗，請稍後再試或聯絡管理員');
  }

  logger.info('LIFF 換發 Custom Token', { username: link.username });
  return { customToken, username: link.username };
});

// 首次用 LINE 登入、這支 LINE 尚未綁過任何帳號時的自助註冊。
//
// 不改動 lineExchangeToken 既有行為——既有病患的登入路徑完全不受影響。
// 這裡刻意獨立成另一個 callable，而不是讓 lineExchangeToken 在「查無綁定」
// 時直接接受註冊資料：lineExchangeToken 的權責是「已驗證的 LINE 帳號 →
// 已存在的 Firebase 使用者」，混進「順便建立新帳號」會讓它從一個單純的
// 查表操作變成一個有副作用的操作，光看函式名字猜不到它可能會建新帳號。
//
// 建帳本體（Auth 帳號 + 五份 Firestore 文件）在 bindings.js 的
// registerPatientViaLine()——跟其餘綁定邏輯放在一起，維持「這四個
// LINE 專屬集合只有 bindings.js 會寫」的既有慣例（見檔案開頭說明）。
exports.lineRegisterPatient = onCall({ region: REGION, secrets: [LINE_CHANNEL_ACCESS_TOKEN] }, async (request) => {
  const data = request.data || {};
  const idToken = data.idToken;
  if (typeof idToken !== 'string' || !idToken) {
    throw new HttpsError('invalid-argument', '缺少 idToken');
  }

  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name) {
    throw new HttpsError('invalid-argument', '請輸入姓名');
  }

  const username = typeof data.username === 'string' ? data.username.trim().toLowerCase() : '';
  const usernameError = validateUsername(username);
  if (usernameError) {
    throw new HttpsError('invalid-argument', usernameError);
  }

  const channelId = LINE_LOGIN_CHANNEL_ID.value();
  if (!channelId) {
    throw new HttpsError('failed-precondition', 'LIFF 尚未設定完成，請聯絡管理員');
  }

  let lineUserId;
  try {
    lineUserId = await resolveLineUserId({ idToken, accessToken: data.accessToken }, channelId);
  } catch (e) {
    logger.warn('LINE ID Token 驗證失敗（首次註冊）', { message: e.message, code: e.code });
    // 區分不同的驗證失敗原因，expired 的意義見 lineExchangeToken 同一段說明。
    const expired = !!(e.message && /expired/i.test(e.message));
    let detailMsg = 'LINE 登入驗證失敗，請重新開啟 LIFF';
    if (expired) {
      detailMsg = 'LINE 登入已逾時，請重新整理頁面再試一次';
    } else if (e.message && e.message.includes('LINE verify')) {
      detailMsg = 'LINE verify 服務暫時無法連接，請稍後再試';
    } else if (e.message && e.message.includes('aud')) {
      detailMsg = 'LINE Login channel 設定不符，請聯絡管理員';
    } else if (e.message && e.message.includes('未設定')) {
      detailMsg = 'LIFF 尚未完全設定，請聯絡管理員';
    }
    throw new HttpsError('unauthenticated', detailMsg, { expired });
  }

  await assertIsFriend(lineUserId);

  // 這支 LINE 已經綁過某個身分（病患本人或家屬）——正常前端流程不會走到
  // 這裡（bootLiff 會先呼叫 lineExchangeToken 並成功），出現代表重放或
  // 使用者手動重複送出，一律拒絕，不覆蓋既有綁定。
  const existingLink = await bindings.findByLineUserId(lineUserId);
  if (existingLink && existingLink.uid) {
    throw new HttpsError('already-exists', '這支 LINE 帳號已經綁定過，請直接登入');
  }

  let result;
  try {
    result = await bindings.registerPatientViaLine({ lineUserId, name, username });
  } catch (e) {
    if (e && e.code === 'username-taken') {
      throw new HttpsError('already-exists', '這個帳號已經有人使用，請換一個');
    }
    logger.error('LINE 首次註冊失敗', { username, message: e.message });
    throw new HttpsError('internal', '註冊失敗，請稍後再試');
  }

  let customToken;
  try {
    customToken = await admin.auth().createCustomToken(result.uid);
  } catch (e) {
    // 同 lineExchangeToken 的說明：最常見原因是服務帳戶缺少
    // 「Service Account Token Creator」角色。
    logger.error('createCustomToken 失敗（LINE 首次註冊）', { username, code: e.code, message: e.message });
    throw new HttpsError('internal', '系統換發登入憑證失敗，請稍後再試或聯絡管理員');
  }

  logger.info('LINE 首次註冊完成', { username });

  // 綁定成功後推送通知（非計費），並提醒設定身分證
  const token = LINE_CHANNEL_ACCESS_TOKEN.value();
  if (token && lineUserId) {
    lineApi.push(token, lineUserId, lineApi.textMessage(
      '綁定成功！\n\n' +
      '之後每天早上會傳用藥提醒卡給您。\n\n' +
      '💡 為了保護您的隱私，請在 MedSafe 網頁設定身分證字號，系統才能進行安全檢查。'
    )).catch(e => {
      logger.error('LINE 綁定成功推播失敗', { username, lineUserId, message: e.message });
    });
  }

  return { customToken, username };
});

// 家屬邀請碼核銷（LIFF 版）：讓家屬直接在 family.html 內貼上邀請碼完成
// 綁定，不必先繞去對話框打字。核銷本體與既有 webhook 文字指令走的是
// 同一支 bindings.redeemFamilyInviteCode()，只是身分來源換成 LIFF ID
// Token（resolveLineUserId），而不是 webhook 事件本身帶的
// event.source.userId——兩條路徑最終落在同一份 Firestore 交易上，
// 不會出現「網頁貼碼綁的」跟「傳訊息綁的」是兩套邏輯的分裂。
//
// 【為什麼在這裡直接換發 Custom Token，而不是核銷完後讓使用者自己重新整理】
// patient.html 的 liffRegisterPatient() 建完帳號後可以 location.reload()
// 讓 bootLiff() 重跑一次 lineExchangeToken 拿到 Custom Token；這裡選擇
// 一次做完（核銷 + 換token），是因為核銷成功「同時」也拿得到
// familyUsername／relationshipLabel，可以直接在同一個畫面顯示「已連結
// （女兒）」，不必多一次重新整理才看得到這段文字。
exports.lineRedeemFamilyInviteCode = onCall({ region: REGION, secrets: [LINE_CHANNEL_ACCESS_TOKEN] }, async (request) => {
  const data = request.data || {};
  const idToken = data.idToken;
  if (typeof idToken !== 'string' || !idToken) {
    throw new HttpsError('invalid-argument', '缺少 idToken');
  }

  const code = typeof data.code === 'string' ? data.code.trim().toUpperCase().replace(/[\s-]/g, '') : '';
  const codeRe = new RegExp('^[' + bindings.ALPHABET + ']{' + bindings.CODE_LEN + '}$');
  if (!codeRe.test(code)) {
    throw new HttpsError('invalid-argument', '邀請碼格式不正確，請確認 8 碼是否輸入完整');
  }

  const channelId = LINE_LOGIN_CHANNEL_ID.value();
  if (!channelId) {
    throw new HttpsError('failed-precondition', 'LIFF 尚未設定完成，請聯絡管理員');
  }

  let lineUserId;
  try {
    lineUserId = await resolveLineUserId({ idToken, accessToken: data.accessToken }, channelId);
  } catch (e) {
    logger.warn('LINE ID Token 驗證失敗（家屬綁定）', { message: e.message, code: e.code });
    // 錯誤分類與 lineExchangeToken 同一套理由，見該函式的說明。
    const expired = !!(e.message && /expired/i.test(e.message));
    let detailMsg = 'LINE 登入驗證失敗，請重新開啟頁面';
    if (expired) {
      detailMsg = 'LINE 登入已逾時，請重新整理頁面再試一次';
    } else if (e.message && e.message.includes('LINE verify')) {
      detailMsg = 'LINE verify 服務暫時無法連接，請稍後再試';
    } else if (e.message && e.message.includes('aud')) {
      detailMsg = 'LINE Login channel 設定不符，請聯絡管理員';
    } else if (e.message && e.message.includes('未設定')) {
      detailMsg = 'LIFF 尚未完全設定，請聯絡管理員';
    }
    throw new HttpsError('unauthenticated', detailMsg, { expired });
  }

  await assertIsFriend(lineUserId);

  const outcome = await bindings.redeemFamilyInviteCode(code, lineUserId);
  if (!outcome.ok) {
    // 文案與 webhook.js 文字指令核銷路徑（handleText 的 CODE_RE 分支）
    // 保持一致，避免兩個入口對同一種失敗說法不同。
    const reasonMsg = {
      'not-found': '這組邀請碼不存在，請確認是否輸入正確。',
      'expired': '這組邀請碼已超過 30 分鐘失效，請請病患重新產生一組。',
      'used': '這組邀請碼已經使用過了，請請病患重新產生一組。',
      'self-invite': '不能用病患自己的 LINE 帳號核銷自己的家屬邀請碼。',
      'already-bound-other-role': '這支 LINE 帳號已經綁定為其他身分，無法再核銷家屬邀請碼。'
    }[outcome.reason] || '核銷失敗，請稍後再試。';
    throw new HttpsError('failed-precondition', reasonMsg, { reason: outcome.reason });
  }

  const link = await bindings.findByLineUserId(lineUserId);
  if (!link || !link.uid) {
    // 理論上核銷成功後一定找得到（redeemFamilyInviteCode 內部剛寫入或
    // 沿用既有的 line_users）；查不到代表資料不一致，比照 lineExchangeToken
    // 對 internal 錯誤的處理方式，不能讓使用者看到看起來成功卻卡住的畫面。
    logger.error('家屬邀請碼核銷成功但查無 line_users 對應', { lineUserId, patient: outcome.patient });
    throw new HttpsError('internal', '綁定資料寫入異常，請稍後再試或聯絡管理員');
  }

  let customToken;
  try {
    customToken = await admin.auth().createCustomToken(link.uid);
  } catch (e) {
    logger.error('createCustomToken 失敗（家屬綁定）', { familyUsername: outcome.familyUsername, code: e.code, message: e.message });
    throw new HttpsError('internal', '系統換發登入憑證失敗，請稍後再試或聯絡管理員');
  }

  logger.info('家屬邀請碼核銷成功（LIFF）', { patient: outcome.patient, familyUsername: outcome.familyUsername });
  return {
    customToken,
    patient: outcome.patient,
    familyUsername: outcome.familyUsername,
    relationshipLabel: outcome.relationshipLabel
  };
});

exports._internal = { extractLineUserId, validateUsername, assertAccessTokenForChannel, extractProfileUserId, resolveLineUserId, assertIsFriend };
