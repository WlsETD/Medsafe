// LIFF 身分橋接（Phase 0，前端一半）。
//
// 只有網址帶 ?liff=1 才會啟動——從 Rich Menu 用 uri action 開啟需要登入身分
// 的頁面時才加這個參數；一般瀏覽器帳密登入完全不載入 LIFF SDK，不受影響。
//
// 流程：liff.init → liff.getIDToken()（絕不把 liff.getProfile() 的
// userId 直接送給後端，官方明文要求由伺服器驗證 ID Token，理由見
// linebot.md §2 附錄連結）→ 呼叫 lineExchangeToken → signInWithCustomToken。
// 換發成功後，這個 webview 就是一個正常登入的病患 session，之後
// verifyRole()／firestore.rules 全部照常生效，呼叫端不需要再做任何事。
//
// 回傳值 { attempted, ok, reason } 讓呼叫端（patient.html）決定失敗時要
// 顯示什麼——尤其「尚未綁定」（reason:'failed-precondition'）不應該被當成
// 一般登入失敗導去 login.html：這支 LINE 可能真的從來沒有任何帳號，正確
// 的下一步是呼叫下面的 liffRegisterPatient() 就地完成首次註冊，而不是叫
// 使用者去網頁版「綁定」一個根本不存在的帳號。
// 【實測發現的坑，別再改回去】firebase-functions-compat.js 送出的
// httpsCallable 錯誤，e.code 不是伺服器丟的裸 HttpsError code（例如
// 'failed-precondition'），而是帶了 'functions/' 前綴（'functions/failed-precondition'）
// ——這是 compat SDK 沿用 v8 時代 auth/xxx、firestore/xxx 那套錯誤碼命名習慣，
// 但後端 exchange.js 丟的是不帶前綴的裸 code。下面回傳的 reason 一律先在
// 這裡剝掉前綴，呼叫端（patient.html）才能直接拿裸 code 比對
// （例如 reason === 'failed-precondition'），不必每個呼叫點都各自記得剝一次。
function bareErrorCode(code) {
  return typeof code === 'string' ? code.replace(/^functions\//, '') : code;
}

function liffAccessToken() {
  try {
    return (typeof liff !== 'undefined' && liff.getAccessToken && liff.getAccessToken()) || null;
  } catch (e) {
    return null;
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('載入 ' + src + ' 失敗'));
    document.head.appendChild(s);
  });
}

// liffId 為選填的指定 LIFF App ID，預設沿用 window.LIFF_ID（病患端 patient.html
// 的既有行為，呼叫端不需要跟著改）。family.html 會傳入 window.FAMILY_LIFF_ID——
// 家屬檢視是另一個獨立的 LIFF App（同一個 LINE Login channel 底下即可，
// 見 functions/src/config.js 的 FAMILY_LIFF_ID 說明），因為它要開的是
// family.html 這個唯讀頁面，不是病患自己的 patient.html。
async function bootLiff(liffId) {
  const params = new URLSearchParams(location.search);
  if (params.get('liff') !== '1') return { attempted: false };

  const id = liffId || window.LIFF_ID;
  if (!id) {
    console.error('LIFF ID 未設定（js/line-liff-config.js），無法使用 LINE 內建登入');
    return { attempted: true, ok: false, reason: 'no-liff-id' };
  }

  try {
    await loadScript('https://static.line-scdn.net/liff/edge/2/sdk.js');
  } catch (e) {
    console.error('LIFF SDK 載入失敗：', e);
    return { attempted: true, ok: false, reason: 'sdk-load-failed' };
  }

  try {
    await liff.init({ liffId: id });
  } catch (e) {
    console.error('LIFF 初始化失敗：', e);
    return { attempted: true, ok: false, reason: 'init-failed' };
  }

  if (!liff.isLoggedIn()) {
    // login() 會導頁離開本頁，之後不會再繼續往下執行。
    liff.login({ redirectUri: location.href });
    return { attempted: true, ok: false, reason: 'redirecting' };
  }

  let idToken;
  try {
    idToken = liff.getIDToken();
  } catch (e) {
    console.error('取得 LINE ID Token 失敗：', e);
    return { attempted: true, ok: false, reason: 'no-id-token' };
  }
  if (!idToken) return { attempted: true, ok: false, reason: 'no-id-token' };

  if (!window.functions) {
    console.error('Cloud Functions SDK 未載入，無法呼叫 lineExchangeToken');
    return { attempted: true, ok: false, reason: 'no-functions-sdk' };
  }

  try {
    // accessToken 只在伺服器判定 ID Token 過期時才會被使用（外部瀏覽器的
    // 快取舊 ID Token 問題，見 functions/src/exchange.js resolveLineUserId 的說明）。
    const r = await window.functions.httpsCallable('lineExchangeToken')({ idToken, accessToken: liffAccessToken() });
    await window.auth.signInWithCustomToken(r.data.customToken);
    sessionStorage.removeItem('liff_relogin_once');
    return { attempted: true, ok: true };
  } catch (e) {
    console.error('LINE 身分交換失敗：', e);
    // 【實測踩過的坑，別再改回去】liff.isLoggedIn() 只代表「這個瀏覽器裡
    // 曾經登入過」，不保證 liff.getIDToken() 拿到的 token 現在還沒過期——
    // SDK 不會主動偵測過期並重新登入，過期的 token 照樣會被回傳，直到打去
    // LINE 的 verify 端點才會被拒絕（伺服器端 exchange.js 判斷到
    // error_description: "IdToken expired." 時，會在 HttpsError 的 details
    // 帶上 { expired: true }，見該檔案說明）。
    //
    // 早期版本在呼叫伺服器之前，先用 liff.getDecodedIDToken() 的 exp claim
    // 自行判斷過期，一旦誤判（例如裝置時間跑掉、或重新登入後 SDK 還沒
    // 更新內部快取）就會卡進「一直判斷過期 → 重新登入 → 還是判斷過期」的
    // 無限迴圈，實測真的發生過，比原本「過期沒處理」更糟。
    //
    // 現在改成：只信任伺服器驗證的結果，且只自動重登入「一次」——用
    // sessionStorage 掛一個旗標當作迴圈防呆。第二次還是過期／失敗，
    // 代表問題不是單純的過期 token（可能是裝置時間、channel 設定等其他
    // 原因），這時候寧可秀出錯誤畫面讓人看得到、回報得出來，也不要繼續
    // 悄悄重導頁讓使用者卡在看不出發生什麼事的迴圈裡。
    //
    // 【實測用診斷 log 追出的根因，別再改回去】外部瀏覽器（不是 LINE App
    // 內建瀏覽器）測試時，liff.login() 若能用瀏覽器既有的 LINE session
    // 做「靜默 SSO」（decoded idToken 的 amr 只有 'linesso'），有時會回傳
    // 快取住的舊 token，exp/iat 完全沒更新，並非邊界差幾秒——實測差了
    // 68 分鐘。只有使用者真的重新輸入密碼／完成兩步驟驗證（amr 帶
    // 'pwd'/'mfa'）走完整登入，才會拿到真正新鮮的 token。這是 LIFF SDK
    // 外部瀏覽器模式本身的行為，不是這支程式能繞開的臭蟲；「重登入一次」
    // 不保證解決，使用者可能要手動再試一次才會觸發完整登入。LINE App
    // 內建瀏覽器（多數病患實際使用的路徑）走的是原生 App 對 App 驗證，
    // 不吃這個 SSO 快取問題。
    const expired = !!(e && e.details && e.details.expired);
    const alreadyRetried = sessionStorage.getItem('liff_relogin_once') === '1';
    if (expired && !alreadyRetried) {
      sessionStorage.setItem('liff_relogin_once', '1');
      liff.login({ redirectUri: location.href });
      return { attempted: true, ok: false, reason: 'redirecting' };
    }
    return { attempted: true, ok: false, reason: bareErrorCode(e && e.code) || 'exchange-failed', message: e && e.message };
  }
}

// 首次用 LINE 登入、bootLiff() 回傳 reason:'failed-precondition' 時呼叫——
// 代表這支 LINE 尚未綁過任何帳號。呼叫端（patient.html）在這裡秀出一個
// 小型註冊表單收姓名／帳號，送出後打這支函式。
//
// 重新呼叫 liff.getIDToken() 而不是把 bootLiff() 裡拿到的 token 存起來傳
// 進來：LIFF 登入之後，liff.getIDToken() 隨時可再取得目前有效的 ID Token，
// 不是一次性、用過即棄的東西，重新取一次比在兩個函式之間傳遞一個短效
// 憑證更不容易在改動時傳錯或用過期。
async function liffRegisterPatient(name, username) {
  if (typeof liff === 'undefined' || !liff.isLoggedIn()) {
    return { ok: false, reason: 'not-logged-in' };
  }

  let idToken;
  try {
    idToken = liff.getIDToken();
  } catch (e) {
    console.error('取得 LINE ID Token 失敗：', e);
    return { ok: false, reason: 'no-id-token' };
  }
  if (!idToken) return { ok: false, reason: 'no-id-token' };

  if (!window.functions) {
    console.error('Cloud Functions SDK 未載入，無法呼叫 lineRegisterPatient');
    return { ok: false, reason: 'no-functions-sdk' };
  }

  try {
    const r = await window.functions.httpsCallable('lineRegisterPatient')({ idToken, accessToken: liffAccessToken(), name, username });
    await window.auth.signInWithCustomToken(r.data.customToken);
    return { ok: true, username: r.data.username };
  } catch (e) {
    console.error('LINE 首次註冊失敗：', e);
    // 不像 bootLiff() 會自動重登入一次：使用者這時剛填完表單，重登會把
    // 輸入內容清空，體驗比顯示「請重新整理再試」更差，因此只回報
    // token-expired 這個明確原因，交給 patient.html 顯示對應訊息，
    // 由使用者自己決定何時重新整理（不自動導頁）。expired 的判斷同樣
    // 來自伺服器（見 exchange.js），不在前端自行猜測，避免誤判。
    const expired = !!(e && e.details && e.details.expired);
    return { ok: false, reason: expired ? 'token-expired' : (bareErrorCode(e && e.code) || 'register-failed'), message: e && e.message };
  }
}

window.bootLiff = bootLiff;
window.liffRegisterPatient = liffRegisterPatient;
