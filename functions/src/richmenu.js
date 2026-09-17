// LINE Rich Menu（聊天室底部常駐選單圖片）的建立/上傳/設為預設。
//
// 【為什麼是手動觸發的 callable，不是自動跑的流程】
// Rich Menu 是「整個官方帳號」層級的設定，不是每個使用者各自的狀態——
// 一次設定就對所有人生效，且選單圖片變動頻率很低（新功能上線才需要換）。
// 因此不掛在 webhook 或排程裡自動跑，而是 admin.html 按一個按鈕手動觸發，
// 跟「展示資料重置」同一種設計：低頻、需要人為確認的操作。
//
// 【四宮格為什麼都是 message action，不是 postback】
// 按下去等同使用者自己打了這句話送出，直接借用 webhook.js 既有的文字
// 指令分支（藥箱／選單，以及本檔新增的「預約」「回報不適」），選單本身
// 不用另外處理 postback——與 line-api.js quickReplyItems() 的 text
// 選項是同一套設計，見該檔說明。

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { REGION, LINE_CHANNEL_ACCESS_TOKEN, LIFF_ID, FAMILY_LIFF_ID } = require('./config');

const RICHMENU_API = 'https://api.line.me/v2/bot/richmenu';
const RICHMENU_DATA_API = 'https://api-data.line.me/v2/bot/richmenu';
const RICHMENU_DEFAULT_API = 'https://api.line.me/v2/bot/user/all/richmenu';
// JPEG 而非 PNG：六格放大後的 PNG 超過 LINE 的 1MB 上限（png 版約 1.16MB），
// 這種扁平設計＋少量漸層的內容改存 JPEG（quality 90）可以壓到 300KB 內，
// 肉眼幾乎看不出差異。上傳時 Content-Type 要記得跟著換成 image/jpeg
// （見 setup() 呼叫 call() 時的 binary 分支）。
const IMAGE_PATH = path.join(__dirname, '../assets/richmenu.jpg');

// 正式站台網址。check.html 是免登入的公開工具（見 04_Security_Audit/0908.md），
// 可以直接用 uri action 開，不用等 Phase 0 的 LIFF 橋接——這是「六宮格
// 但只有四格真的能用」之外，額外多出來立刻能用的一格（schedule.html
// 這個列印工具仍然存在，只是不再掛在 Rich Menu 上，見下方「服藥時間表」的說明）。
const SITE_ORIGIN = 'https://medsafe-554b7.web.app';

// 3x2 六宮格。「使用說明」是既有文字指令；「回報不適」是 Phase 4
// 兩步式真正功能（見 webhook.js 的 SYMPTOM_RE／startSymptomReport），
// 不再是開發中提示。「綁定家屬」直接連到免登入的教學頁面，不需要任何
// 後端處理——邀請碼本身是病患各自產生的、無法在帳號層級的選單裡帶入，
// 因此這一格只能是靜態教學頁，實際核銷仍是使用者把邀請碼貼進對話框
// 觸發既有的 webhook 文字比對流程（見 family-bind-help.html 的說明）。
// 原本掛在這一格的「用藥查詢」（check.html）並未刪除，只是拿掉選單入口，
// 它本來就是設計給外部分享連結用的免登入公益工具，不受影響。
//
// 【「藥箱」「服藥時間表」為什麼是文字指令，不是直接開網頁】
// 「藥箱」原本在 LIFF_ID 設定後改成直接 uri 開 patient.html；「服藥時間表」
// 原本就是 uri 開 schedule.html。使用者反映這兩格按下去不該跳出瀏覽器——
// 改回文字指令的形狀：按下去等同送出那句話，Bot 用 Reply（免費）回一段
// 內容。「藥箱」回一段純文字摘要；「服藥時間表」借用 webhook.js 的
// SCHEDULE_RE 分支，回覆跟每日提醒卡（reminder.js）同一張、可直接按
// 按鈕回報的 Flex 卡片——病患點下去期待的是「今天實際要吃的藥」，
// 不是一張空白表單，純文字列表也少了「按一下就回報」這個動作。
// 「完整藥箱」仍保留在 menuItems() 的快速回覆選單中，是額外的、明確
// 標示「完整」的可選項，給想看完整用藥時間軸與所有 DDI 細節的人另外
// 點——與這裡的變更沒有衝突。
//
// 【「線上預約」為什麼還是動態決定 message 或 uri，沒有一併改掉】
// 掛號需要選日期、診次、填寫結帳資訊，文字指令做不到（同一個理由，
// linebot.md §4.2 論證過對話式重刻掛號流程不會更安全，只會多一份要跟
// firestore.rules 保持一致的邏輯）。有了 LIFF_ID 之後直接 uri 到
// https://liff.line.me/{id}?view=appointments，一次點擊就進 App。
// LIFF_ID 未設定時（尚未走完 Phase 0）不能硬編一個空字串當 uri——
// LINE 建立選單時會直接拒絕沒有合法網址的 uri action，因此保留舊的
// message 分支（借用 webhook.js 既有的 BOOKING_RE 文字指令），與
// webhook.js 的 menuItems()「LIFF_ID 未設定不顯示完整藥箱按鈕」是同一種
// 「功能未就緒時優雅降級」設計。
// 「綁定家屬」按鈕的動作，被 buildAreas()（大選單）與 webhook.js 的
// menuItems()（快速回覆選單）兩處共用——抽成獨立函式而非各自判斷一次
// FAMILY_LIFF_ID，避免日後改其中一邊時忘了改另一邊，跟 flex.js
// tutorialCarousel() 直接沿用 buildAreas() 是同一個「單一事實來源」考量。
//
// FAMILY_LIFF_ID 已設定時直接開 family.html 的 LIFF 頁面——尚未綁定的
// LINE 帳號會被 family.html 的 bootLiff() 導向就地貼邀請碼的表單
// （renderFamilyBindForm()，見該檔案說明），一次點擊就能完成綁定，不必
// 先跳教學頁再手動把碼貼進對話框。FAMILY_LIFF_ID 未設定時（LIFF App
// 尚未註冊完成）退回純教學頁，與其餘 LIFF 功能「未就緒時優雅降級」
// 是同一種設計。
function familyBindAction() {
  const familyLiffId = FAMILY_LIFF_ID.value();
  return familyLiffId
    ? { type: 'uri', label: '綁定家屬', uri: 'https://liff.line.me/' + familyLiffId }
    : { type: 'uri', label: '綁定家屬', uri: SITE_ORIGIN + '/family-bind-help.html' };
}

function buildAreas() {
  const liffId = LIFF_ID.value();
  const bookingAction = liffId
    ? { type: 'uri', label: '線上預約', uri: 'https://liff.line.me/' + liffId + '?view=appointments' }
    : { type: 'message', label: '線上預約', text: '預約' };
  return [
    { bounds: { x: 0, y: 0, width: 834, height: 843 },
      action: { type: 'message', label: '藥箱', text: '藥箱' } },
    { bounds: { x: 834, y: 0, width: 833, height: 843 }, action: bookingAction },
    { bounds: { x: 1667, y: 0, width: 833, height: 843 },
      action: { type: 'message', label: '回報不適', text: '回報不適' } },
    { bounds: { x: 0, y: 843, width: 834, height: 843 },
      action: { type: 'message', label: '使用說明', text: '選單' } },
    { bounds: { x: 834, y: 843, width: 833, height: 843 }, action: familyBindAction() },
    { bounds: { x: 1667, y: 843, width: 833, height: 843 },
      action: { type: 'message', label: '服藥時間表', text: '服藥時間表' } }
  ];
}

function buildDefinition() {
  return {
    size: { width: 2500, height: 1686 },
    // 預設展開（不是收合成一條小 tab）——比照使用者參考的 LINE 官方帳號
    // 選單體驗，加好友／開啟對話當下就看得到整張圖。
    selected: true,
    name: 'MedSafe 主選單',
    chatBarText: '選單',
    areas: buildAreas()
  };
}

// 可注入的 HTTP 層，供測試 mock 用；真實實作見檔尾 defaultHttp。
let httpImpl = null;

async function defaultHttp({ method, url, token, body, binary }) {
  const res = await fetch(url, {
    method,
    headers: Object.assign(
      { Authorization: 'Bearer ' + token },
      binary ? { 'Content-Type': 'image/jpeg' } : { 'Content-Type': 'application/json' }
    ),
    body: binary ? body : (body != null ? JSON.stringify(body) : undefined)
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error('LINE API ' + res.status + '：' + text.slice(0, 300));
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    // 圖片上傳等端點成功時不一定回 JSON，空字串以外的非 JSON 內容忽略即可。
    return null;
  }
}

function call(req) {
  const impl = httpImpl || defaultHttp;
  return impl(req);
}

// 【對外】建立選單、上傳圖片、設為預設，並清掉舊選單。
// image 參數可注入（測試用假圖片 buffer），預設讀 functions/assets/richmenu.jpg。
async function setup(token, image) {
  const jpg = image || fs.readFileSync(IMAGE_PATH);
  const definition = buildDefinition();

  // 一、建立新選單結構，拿到 richMenuId。
  const created = await call({ method: 'POST', url: RICHMENU_API, token, body: definition });
  const richMenuId = created && created.richMenuId;
  if (!richMenuId) throw new Error('建立選單失敗：LINE 未回傳 richMenuId');

  // 二、上傳圖片（二進位 body，不是 JSON）。
  await call({ method: 'POST', url: RICHMENU_DATA_API + '/' + richMenuId + '/content', token, body: jpg, binary: true });

  // 三、設為所有使用者的預設選單。
  await call({ method: 'POST', url: RICHMENU_DEFAULT_API + '/' + richMenuId, token });

  // 四、清掉舊選單，避免帳號可建立的選單數量累積到上限。
  // 這一步失敗不影響本次設定的結果——新選單在步驟三就已經生效，
  // 舊選單留著頂多占用額度，使用者不會看到任何錯誤，因此只記錄不拋出。
  let deletedIds = [];
  try {
    const list = await call({ method: 'GET', url: RICHMENU_API + '/list', token });
    const old = ((list && list.richmenus) || []).filter(m => m.richMenuId !== richMenuId);
    for (const m of old) {
      await call({ method: 'DELETE', url: RICHMENU_API + '/' + m.richMenuId, token });
      deletedIds.push(m.richMenuId);
    }
  } catch (e) {
    logger.error('清除舊選單失敗（新選單已生效，不影響本次結果）', { error: e.message });
  }

  return { richMenuId, deletedOldMenuIds: deletedIds };
}

// 由 uid 取出可信的身分，僅限管理員。與 callable.js 的 requirePatient
// 同一種寫法（request.auth 為唯一信任來源，不採信前端宣稱的角色）。
async function requireAdmin(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', '請先登入');
  const snap = await admin.firestore().collection('user_roles').doc(request.auth.uid).get();
  const p = snap.exists ? snap.data() : null;
  if (!p || p.status !== 'active' || p.role !== 'admin') {
    throw new HttpsError('permission-denied', '僅限管理員操作');
  }
}

const lineSetupRichMenu = onCall({ region: REGION, secrets: [LINE_CHANNEL_ACCESS_TOKEN] }, async (request) => {
  await requireAdmin(request);
  const result = await setup(LINE_CHANNEL_ACCESS_TOKEN.value());
  logger.info('LINE 選單圖片已更新', result);
  return result;
});

module.exports = {
  setup,
  requireAdmin,
  lineSetupRichMenu,
  buildAreas,
  buildDefinition,
  familyBindAction,
  SITE_ORIGIN,
  // 【測試用】注入/恢復 HTTP 實作
  setImpl(fn) { httpImpl = fn; },
  resetImpl() { httpImpl = null; }
};
