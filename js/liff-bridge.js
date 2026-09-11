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
// 顯示什麼——尤其「尚未綁定」不應該被當成一般登入失敗導去 login.html，
// 因為在這支手機上打開 LIFF 的人可能從來沒有輸入過帳號密碼。
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('載入 ' + src + ' 失敗'));
    document.head.appendChild(s);
  });
}

async function bootLiff() {
  const params = new URLSearchParams(location.search);
  if (params.get('liff') !== '1') return { attempted: false };

  if (!window.LIFF_ID) {
    console.error('LIFF_ID 未設定（js/line-liff-config.js），無法使用 LINE 內建登入');
    return { attempted: true, ok: false, reason: 'no-liff-id' };
  }

  try {
    await loadScript('https://static.line-scdn.net/liff/edge/2/sdk.js');
  } catch (e) {
    console.error('LIFF SDK 載入失敗：', e);
    return { attempted: true, ok: false, reason: 'sdk-load-failed' };
  }

  try {
    await liff.init({ liffId: window.LIFF_ID });
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
    const r = await window.functions.httpsCallable('lineExchangeToken')({ idToken });
    await window.auth.signInWithCustomToken(r.data.customToken);
    return { attempted: true, ok: true };
  } catch (e) {
    console.error('LINE 身分交換失敗：', e);
    return { attempted: true, ok: false, reason: (e && e.code) || 'exchange-failed', message: e && e.message };
  }
}

window.bootLiff = bootLiff;
