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

const { REGION, LINE_LOGIN_CHANNEL_ID } = require('./config');
const bindings = require('./bindings');

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
          return reject(new Error('LINE verify 回應非 JSON'));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(json.error_description || json.error || 'LINE verify 回應 ' + res.statusCode));
        }
        resolve(json);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
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

exports.lineExchangeToken = onCall({ region: REGION }, async (request) => {
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
    const verified = await verifyIdToken(idToken, channelId);
    lineUserId = extractLineUserId(verified, channelId);
  } catch (e) {
    logger.warn('LINE ID Token 驗證失敗', { message: e.message });
    throw new HttpsError('unauthenticated', 'LINE 登入驗證失敗，請重新開啟');
  }

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

exports._internal = { extractLineUserId };
