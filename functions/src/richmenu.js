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
const { REGION, LINE_CHANNEL_ACCESS_TOKEN } = require('./config');

const RICHMENU_API = 'https://api.line.me/v2/bot/richmenu';
const RICHMENU_DATA_API = 'https://api-data.line.me/v2/bot/richmenu';
const RICHMENU_DEFAULT_API = 'https://api.line.me/v2/bot/user/all/richmenu';
const IMAGE_PATH = path.join(__dirname, '../assets/richmenu.png');

// 目前只有「藥箱」「選單」是真的能用的功能，「預約」「回報不適」是
// Phase 0／Phase 4 完成前的預告格——圖片上有標「即將推出」，文字指令
// 也回覆誠實的「開發中」訊息，不是按了沒反應的死按鈕。之後功能上線時，
// 這裡的 text 不用改，只要 webhook.js 那個分支從「即將推出」訊息
// 換成真正的處理邏輯即可。
const AREAS = [
  { bounds: { x: 0, y: 0, width: 1250, height: 422 },
    action: { type: 'message', label: '藥箱', text: '藥箱' } },
  { bounds: { x: 1250, y: 0, width: 1250, height: 422 },
    action: { type: 'message', label: '預約', text: '預約' } },
  { bounds: { x: 0, y: 422, width: 1250, height: 421 },
    action: { type: 'message', label: '回報不適', text: '回報不適' } },
  { bounds: { x: 1250, y: 422, width: 1250, height: 421 },
    action: { type: 'message', label: '選單', text: '選單' } }
];

const DEFINITION = {
  size: { width: 2500, height: 843 },
  selected: false,
  name: 'MedSafe 主選單',
  chatBarText: '選單',
  areas: AREAS
};

// 可注入的 HTTP 層，供測試 mock 用；真實實作見檔尾 defaultHttp。
let httpImpl = null;

async function defaultHttp({ method, url, token, body, binary }) {
  const res = await fetch(url, {
    method,
    headers: Object.assign(
      { Authorization: 'Bearer ' + token },
      binary ? { 'Content-Type': 'image/png' } : { 'Content-Type': 'application/json' }
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
// image 參數可注入（測試用假圖片 buffer），預設讀 functions/assets/richmenu.png。
async function setup(token, image) {
  const png = image || fs.readFileSync(IMAGE_PATH);

  // 一、建立新選單結構，拿到 richMenuId。
  const created = await call({ method: 'POST', url: RICHMENU_API, token, body: DEFINITION });
  const richMenuId = created && created.richMenuId;
  if (!richMenuId) throw new Error('建立選單失敗：LINE 未回傳 richMenuId');

  // 二、上傳圖片（二進位 body，不是 JSON）。
  await call({ method: 'POST', url: RICHMENU_DATA_API + '/' + richMenuId + '/content', token, body: png, binary: true });

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
  AREAS,
  DEFINITION,
  // 【測試用】注入/恢復 HTTP 實作
  setImpl(fn) { httpImpl = fn; },
  resetImpl() { httpImpl = null; }
};
