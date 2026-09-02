// 帳號登入用 Firebase Auth，前端不知道也不需要知道真實 email，
// 一律用「帳號 + 固定網域」組出一個內部使用的合成 email
const AUTH_EMAIL_DOMAIN = '@medsafe.local';
function toAuthEmail(username) {
  return String(username).trim().toLowerCase() + AUTH_EMAIL_DOMAIN;
}

// 本頁經過伺服器驗證的身分。頁面一律讀這裡，不再讀 localStorage——
// localStorage 可以在瀏覽器 Console 用一行指令竄改，不能當作授權依據。
// 真正的權限仍由 Firestore 規則以 request.auth.uid 把關，此處是讓「畫面」也不再被騙。
let _verifiedUser = null;
function getVerifiedUser() { return _verifiedUser; }
// 舊名稱保留，語意已改為「取得已驗證身分」；未經 verifyRole 之前一律為 null
function getCurrentUser() { return _verifiedUser; }

// 登出與驗證失敗時都要清乾淨：除了登入身分，聊天訊息與通知等 medsafe_* 快取也必須一併清除，
// 否則同一台機器上的下一位使用者會讀到前一位殘留的訊息內容。
function clearLocalState() {
  try {
    localStorage.removeItem('demo_user');
    Object.keys(localStorage)
      .filter(k => k.indexOf('medsafe_') === 0)
      .forEach(k => localStorage.removeItem(k));
  } catch (e) { /* 隱私模式下 localStorage 可能拋錯，不應因此中斷登出 */ }
}

// 各角色的首頁。角色不符時導回自己的頁面，而不是把人登出。
const ROLE_HOME = {
  admin: 'admin.html',
  doctor: 'dashboard.html',
  patient: 'patient.html',
  insurance: 'insurance.html'
};

// 「你不該進這棟樓」：沒有登入，或帳號已被停用。
// 這種情況才清除本地狀態並登出——先清空畫面，避免未授權內容在導頁前閃現；
// 用 replace 讓上一頁不留在歷史紀錄中。
function denyAndRedirect() {
  try { if (document.body) document.body.innerHTML = ''; } catch (e) {}
  clearLocalState();
  if (window.auth) { try { window.auth.signOut(); } catch (e) {} }
  window.location.replace('login.html');
}

// 「你走錯房間」：身分合法，只是這一頁不屬於你的角色。
// 不得登出、不得清除本地資料——使用者沒有做錯任何事，可能只是點到舊書籤。
function redirectToOwnHome(role) {
  try { if (document.body) document.body.innerHTML = ''; } catch (e) {}
  window.location.replace(ROLE_HOME[role] || 'login.html');
}

// 基礎設施故障（離線、逾時）不是攻擊，不可用登出與清除資料來處置。
// 這裡只顯示一個可重試的畫面，本地資料原封不動。
function showAuthRetryScreen(detail) {
  try {
    document.title = '連線失敗 | MedSafe';
    document.body.innerHTML =
      '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;'
      + 'font-family:system-ui,-apple-system,Segoe UI,Noto Sans TC,sans-serif;background:#F7F8FA;padding:24px">'
      + '<div style="max-width:420px;text-align:center;background:#fff;border-radius:24px;padding:40px 32px;'
      + 'box-shadow:0 8px 32px rgba(15,23,42,.08)">'
      + '<div style="font-size:40px;line-height:1;margin-bottom:16px">&#128246;</div>'
      + '<h1 style="font-size:20px;font-weight:800;color:#0F172A;margin:0 0 8px">無法連線至伺服器</h1>'
      + '<p style="font-size:13px;color:#64748B;line-height:1.7;margin:0 0 24px">'
      + '目前無法驗證您的登入狀態，通常是網路暫時中斷所致。<br>'
      + '<strong>您仍然是登入狀態，本機資料未被清除。</strong>請恢復連線後重試。</p>'
      + '<button onclick="window.location.reload()" style="background:#24A15D;color:#fff;border:0;'
      + 'border-radius:16px;padding:14px 32px;font-size:13px;font-weight:800;cursor:pointer">重新嘗試</button>'
      // 逃生出口：若失敗原因不是暫時性斷線（例如 SW 送出舊版 JS 造成的 TypeError），
      // 重試會永遠回到同一個畫面，使用者需要一個離開的方式
      + '<p style="font-size:11px;color:#64748B;margin-top:20px">仍有問題？'
      + '<a href="login.html" style="color:#24A15D;font-weight:800">重新登入</a></p>'
      + (detail
          ? '<p style="font-size:10px;color:#94A3B8;margin-top:12px">' + detail + '</p>'
          : '<p style="font-size:10px;color:#94A3B8;margin-top:12px">'
            + '若重試多次仍失敗，可能是瀏覽器快取了舊版程式，請清除本站資料後再試。</p>')
      + '</div></div>';
  } catch (e) { /* 連畫面都寫不了時就什麼都不做，至少不要毀掉資料 */ }
}

// 等待 Firebase Auth 還原持久化的登入狀態後再繼續，
// 避免頁面重整時 Firestore 請求搶在 request.auth 就緒之前送出而被規則拒絕
function waitForAuthReady() {
  return new Promise(resolve => {
    const unsubscribe = window.auth.onAuthStateChanged(u => {
      unsubscribe();
      resolve(u);
    });
  });
}

// 以 Firebase Auth 的 uid 向 Firestore 查角色，取代原本只讀 localStorage 的檢查。
// user_roles/{uid} 受安全規則保護（只有本人讀得到自己那份），因此偽造不了。
// expectedRole 傳 null 代表「只要是有效且啟用中的帳號即可」。
async function verifyRole(expectedRole) {
  if (!window.auth || !window.DbService) { denyAndRedirect(); return null; }

  const fbUser = await waitForAuthReady();
  if (!fbUser) { denyAndRedirect(); return null; }

  let profile;
  try {
    profile = await DbService.getUserRole(fbUser.uid);
  } catch (e) {
    // 錯誤必須分類。把「網路不通」當成「你是攻擊者」來處置，
    // 代價是強制登出並清掉只存在於 localStorage、伺服器沒有副本的醫病對話紀錄——
    // 使用者在電梯裡重整一次頁面就會永久遺失資料。
    if (e && e.code === 'permission-denied') { denyAndRedirect(); return null; }
    showAuthRetryScreen(e && e.code ? ('錯誤代碼：' + e.code) : '');
    return null;
  }

  // 帳號不存在或已被停用：這才是「不該進這棟樓」
  if (!profile || profile.status !== 'active') { denyAndRedirect(); return null; }

  // 角色不符：身分合法，只是走錯房間。導回自己的首頁，不登出、不清資料。
  if (expectedRole && profile.role !== expectedRole) {
    redirectToOwnHome(profile.role);
    return null;
  }

  _verifiedUser = { username: profile.username, role: profile.role, name: profile.name };
  // 仍寫回 localStorage 供既有元件讀取顯示用資料，但它已不是信任來源
  try { localStorage.setItem('demo_user', JSON.stringify(_verifiedUser)); } catch (e) {}
  return _verifiedUser;
}

// 驗證通過才掛載 Vue。未通過時整個 app 不會被建立，
// 因此不再有原本「先用 { name: '訪客...' } 渲染出畫面、再非同步導頁」的空窗期。
async function mountWhenAuthorized(app, expectedRole) {
  const user = await verifyRole(expectedRole);
  if (!user) return null;
  // 樣板可直接呼叫 avatarUrl()，頭像一律本地產生，不對外送出姓名
  app.config.globalProperties.avatarUrl = window.localAvatar;
  return app.mount('#app');
}

// 登出：本地狀態與 Firebase Auth 的登入狀態都要清掉，且等 signOut 完成再導頁
async function logout() {
  // 解除對話的即時監聽並清空記憶體中的訊息（稽核報告 P1-4）。
  // 不做這件事，切換帳號後前一位使用者的對話仍留在同一個 JS 環境裡，
  // 且舊的 Firestore 監聽會持續運作到頁面真正卸載為止。
  if (window.chatStore && window.chatStore.dispose) {
    try { window.chatStore.dispose(); } catch (e) { /* 清理失敗不應阻擋登出 */ }
  }
  clearLocalState();
  if (window.auth) {
    try { await window.auth.signOut(); } catch (e) { /* 即使失敗仍要離開此頁 */ }
  }
  window.location.replace('login.html');
}

// 用 Firebase Authentication 登入，並讀取 user_roles/{uid} 取得角色資料
async function loginWithFirebaseAuth(username, password) {
  let cred;
  try {
    cred = await window.auth.signInWithEmailAndPassword(toAuthEmail(username), password);
  } catch (e) {
    return null; // 帳號不存在或密碼錯誤
  }
  const profile = await DbService.getUserRole(cred.user.uid);
  if (!profile) {
    await window.auth.signOut();
    return null;
  }
  if (profile.status === 'disabled') {
    await window.auth.signOut();
    return { disabled: true };
  }
  return { username: profile.username, role: profile.role, name: profile.name };
}
