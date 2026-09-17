// LINE Rich Menu 建立/上傳/設為預設/清舊選單的測試。
//
// 這份測試守的是：
//   一、六宮格區域完整覆蓋 2500x843 且互不重疊（不然會有按了沒反應的死角）
//   二、setup() 依正確順序呼叫 LINE API（建立 → 上傳圖片 → 設為預設 → 清舊選單）
//   三、清舊選單失敗不影響本次設定的結果（新選單在步驟三已生效）
//   四、image content-type 一定是二進位，不能被序列化成 JSON 字串送出
//
// LINE API 全程 mock，不打真的網路。
//
// 執行：node tests/line-richmenu.test.mjs（不需要 Firestore 模擬器）

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const richmenu = require('../functions/src/richmenu.js');

const results = [];
const check = (name, cond, detail) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (detail || '')]);

const FAKE_TOKEN = 'test-channel-access-token';
const FAKE_IMAGE = Buffer.from('fake-png-bytes');

function mockCalls(handler) {
  const calls = [];
  richmenu.setImpl(async (req) => {
    calls.push(req);
    return handler(req, calls);
  });
  return calls;
}

// ── 一、區域定義本身 ─────────────────────────────────────────────────
//
// buildAreas()／buildDefinition() 依 LIFF_ID 是否設定動態決定「藥箱」
// 「線上預約」兩格是 message 還是直接開 LIFF 的 uri（見 richmenu.js
// 該函式上方註解）。跟 webhook.js 的 menuItems() 測試同一種做法：
// 直接切換 process.env.LIFF_ID，兩種狀態都要驗過，並在結束時還原。

const originalLiffIdForAreas = process.env.LIFF_ID;

// 狀態一：LIFF_ID 未設定（Phase 0 尚未完成）——兩格都退回 message。
delete process.env.LIFF_ID;
const areasNoLiff = richmenu.buildAreas();
const definitionNoLiff = richmenu.buildDefinition();

{
  const total = areasNoLiff.reduce((sum, a) => sum + a.bounds.width * a.bounds.height, 0);
  const expected = definitionNoLiff.size.width * definitionNoLiff.size.height;
  check('六宮格面積總和等於畫布面積（無空隙、無重疊）', total === expected,
    'total=' + total + ' expected=' + expected);
}
{
  // 兩兩檢查矩形是否重疊（AABB 相交測試）。
  const overlaps = [];
  for (let i = 0; i < areasNoLiff.length; i++) {
    for (let j = i + 1; j < areasNoLiff.length; j++) {
      const a = areasNoLiff[i].bounds, b = areasNoLiff[j].bounds;
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width
        && a.y < b.y + b.height && b.y < a.y + a.height;
      if (overlap) overlaps.push([i, j]);
    }
  }
  check('六宮格彼此不重疊', overlaps.length === 0, JSON.stringify(overlaps));
}
{
  const bad = areasNoLiff.filter(a => !a.action.label || a.action.label.length > 20);
  check('每格 label 存在且不超過 LINE 的 20 字上限', bad.length === 0);
}
{
  // 兩種合法型別：message（借用既有文字指令分支，按下去等同送出那句話，
  // Bot 用 Reply 回文字或 Flex 卡片）與 uri（直接開免登入公開頁面，例如
  // family-bind-help.html，或已設定 LIFF_ID 時的線上預約，需要選日期／診次，
  // 文字指令做不到）。
  const checkTypes = (areas) => areas.filter(a => {
    if (a.action.type === 'message') return !a.action.text;
    if (a.action.type === 'uri') return !a.action.uri || !a.action.uri.startsWith('https://');
    return true; // 其餘型別（例如 postback）目前不該出現在選單裡
  });
  check('每格都是 message（帶 text）或 uri（帶 https 連結），沒有其他型別',
    checkTypes(areasNoLiff).length === 0, JSON.stringify(checkTypes(areasNoLiff)));
}
{
  const messageCount = areasNoLiff.filter(a => a.action.type === 'message').length;
  const uriCount = areasNoLiff.filter(a => a.action.type === 'uri').length;
  // 藥箱／服藥時間表原本在 LIFF_ID 設定後（或本來就）會開網頁，
  // 使用者反映按下去不該跳出瀏覽器，改成文字指令，只剩「綁定家屬」
  // （教學頁，邀請碼是病患各自產生的，無法在帳號層級選單裡帶入）仍是 uri。
  check('LIFF_ID 未設定時，六宮格共 6 格：5 格文字指令 + 1 格免登入公開頁面連結',
    areasNoLiff.length === 6 && messageCount === 5 && uriCount === 1);
}
{
  const w = definitionNoLiff.size.width, h = definitionNoLiff.size.height;
  check('選單圖片尺寸符合 LINE 規格（2500x843 或 2500x1686）',
    w === 2500 && (h === 843 || h === 1686));
}

// 狀態二：LIFF_ID 已設定（Phase 0 完成）——只有「線上預約」改成一次點擊
// 直接開 LIFF 的 uri action（需要選日期／診次，文字指令做不到）；「藥箱」
// 維持 message，不因 LIFF_ID 而改變（見 buildAreas() 上方的說明）。
process.env.LIFF_ID = 'test-liff-id-0003';
const areasWithLiff = richmenu.buildAreas();
{
  const cabinet = areasWithLiff[0], booking = areasWithLiff[1];
  check('LIFF_ID 已設定時，「藥箱」格仍是 message（按下去回文字，不開網頁）',
    cabinet.action.type === 'message' && cabinet.action.text === '藥箱');
  check('LIFF_ID 已設定時，「線上預約」格帶 ?view=appointments 深連結',
    booking.action.type === 'uri' && booking.action.uri === 'https://liff.line.me/test-liff-id-0003?view=appointments');
  const messageCount = areasWithLiff.filter(a => a.action.type === 'message').length;
  const uriCount = areasWithLiff.filter(a => a.action.type === 'uri').length;
  check('LIFF_ID 已設定時，六宮格變成 4 格文字指令 + 2 格連結（線上預約與綁定家屬）',
    areasWithLiff.length === 6 && messageCount === 4 && uriCount === 2);
}

if (originalLiffIdForAreas === undefined) delete process.env.LIFF_ID;
else process.env.LIFF_ID = originalLiffIdForAreas;

// 狀態三：FAMILY_LIFF_ID（家屬 LIFF App）已設定——「綁定家屬」格改為直接
// 開 family.html 的 LIFF 頁面，不再是免登入教學頁。與 LIFF_ID 的測法
// 同一個模式：直接切換 process.env，結束後還原。
const originalFamilyLiffId = process.env.FAMILY_LIFF_ID;

delete process.env.FAMILY_LIFF_ID;
{
  const areas = richmenu.buildAreas();
  const familyBind = areas.find(a => a.action.label === '綁定家屬');
  check('FAMILY_LIFF_ID 未設定時，「綁定家屬」退回免登入教學頁',
    !!familyBind && familyBind.action.type === 'uri'
    && familyBind.action.uri === richmenu.SITE_ORIGIN + '/family-bind-help.html');
}

process.env.FAMILY_LIFF_ID = 'test-family-liff-id-0007';
{
  const areas = richmenu.buildAreas();
  const familyBind = areas.find(a => a.action.label === '綁定家屬');
  check('FAMILY_LIFF_ID 已設定時，「綁定家屬」直接開 LIFF 頁面',
    !!familyBind && familyBind.action.type === 'uri'
    && familyBind.action.uri === 'https://liff.line.me/test-family-liff-id-0007');

  check('familyBindAction() 匯出函式與 buildAreas() 用的是同一個結果（單一事實來源）',
    JSON.stringify(richmenu.familyBindAction()) === JSON.stringify(familyBind.action));
}

if (originalFamilyLiffId === undefined) delete process.env.FAMILY_LIFF_ID;
else process.env.FAMILY_LIFF_ID = originalFamilyLiffId;

// ── 二、setup() 的呼叫順序與參數 ────────────────────────────────────

{
  const calls = mockCalls((req) => {
    if (req.url.endsWith('/richmenu')) return { richMenuId: 'rm-new' };
    if (req.url.includes('/content')) return null;
    if (req.url.includes('/user/all/richmenu/')) return null;
    if (req.url.endsWith('/list')) return { richmenus: [] };
    return null;
  });

  const result = await richmenu.setup(FAKE_TOKEN, FAKE_IMAGE);
  richmenu.resetImpl();

  check('setup() 依序呼叫：建立 → 上傳圖片 → 設為預設 → 列出舊選單',
    calls.length === 4
    && calls[0].method === 'POST' && calls[0].url === 'https://api.line.me/v2/bot/richmenu'
    && calls[1].url === 'https://api-data.line.me/v2/bot/richmenu/rm-new/content'
    && calls[2].url === 'https://api.line.me/v2/bot/user/all/richmenu/rm-new'
    && calls[3].url === 'https://api.line.me/v2/bot/richmenu/list',
    JSON.stringify(calls.map(c => c.method + ' ' + c.url)));

  check('上傳圖片那一步標記為二進位、且 body 就是原始圖片 bytes（不是 JSON.stringify 過的字串）',
    calls[1].binary === true && calls[1].body === FAKE_IMAGE);

  check('建立選單那一步送出完整的 definition（六宮格區域）',
    JSON.stringify(calls[0].body) === JSON.stringify(richmenu.buildDefinition()));

  check('回傳新建立的 richMenuId', result.richMenuId === 'rm-new');
}

{
  // 每個 call 都要帶正確的 Authorization——用假 token 直接檢查請求本身有沒有把 token 傳進去，
  // 不是檢查 HTTP header（defaultHttp 才組 header，這裡測的是 setup() 有沒有把 token 往下傳）。
  const calls = mockCalls((req) => {
    if (req.url.endsWith('/richmenu')) return { richMenuId: 'rm-x' };
    if (req.url.endsWith('/list')) return { richmenus: [] };
    return null;
  });
  await richmenu.setup(FAKE_TOKEN, FAKE_IMAGE);
  richmenu.resetImpl();
  check('每一次 LINE API 呼叫都帶同一組 token', calls.every(c => c.token === FAKE_TOKEN));
}

// ── 三、清舊選單：只刪別人，不刪自己剛建立的那個；失敗不影響結果 ──────

{
  const calls = mockCalls((req) => {
    if (req.method === 'POST' && req.url.endsWith('/richmenu')) return { richMenuId: 'rm-new' };
    if (req.url.endsWith('/list')) {
      return { richmenus: [{ richMenuId: 'rm-old-1' }, { richMenuId: 'rm-new' }, { richMenuId: 'rm-old-2' }] };
    }
    return null;
  });
  const result = await richmenu.setup(FAKE_TOKEN, FAKE_IMAGE);
  richmenu.resetImpl();

  const deleteCalls = calls.filter(c => c.method === 'DELETE');
  check('刪除呼叫只針對舊選單，不含剛建立的那一個',
    deleteCalls.length === 2
    && deleteCalls.every(c => c.url.endsWith('/rm-old-1') || c.url.endsWith('/rm-old-2'))
    && !deleteCalls.some(c => c.url.endsWith('/rm-new')));

  check('回傳值列出被刪除的舊選單 id',
    result.deletedOldMenuIds.length === 2
    && result.deletedOldMenuIds.includes('rm-old-1')
    && result.deletedOldMenuIds.includes('rm-old-2'));
}

{
  // 列出/刪除舊選單那一步整個炸掉，setup() 仍要回傳成功結果——
  // 新選單在步驟三（設為預設）已經生效，這一步只是清理，不該讓使用者
  // 看到「設定失敗」而以為選單沒換成功。
  let threw = false;
  let result = null;
  mockCalls((req) => {
    if (req.method === 'POST' && req.url.endsWith('/richmenu')) return { richMenuId: 'rm-new' };
    if (req.url.endsWith('/content')) return null;
    if (req.url.includes('/user/all/richmenu/')) return null;
    if (req.url.endsWith('/list')) throw new Error('LINE API 502');
    return null;
  });
  try {
    result = await richmenu.setup(FAKE_TOKEN, FAKE_IMAGE);
  } catch (e) {
    threw = true;
  }
  richmenu.resetImpl();
  check('清舊選單失敗不會讓 setup() 整個拋錯',
    !threw && result && result.richMenuId === 'rm-new' && result.deletedOldMenuIds.length === 0);
}

// ── 四、建立選單本身失敗時必須明確拋錯，不可悄悄回傳空值 ────────────

{
  let threw = false;
  mockCalls((req) => {
    if (req.url.endsWith('/richmenu')) return {}; // 沒有 richMenuId
    return null;
  });
  try {
    await richmenu.setup(FAKE_TOKEN, FAKE_IMAGE);
  } catch (e) {
    threw = true;
  }
  richmenu.resetImpl();
  check('LINE 未回傳 richMenuId 時必須拋錯，不可用 undefined 繼續往下跑', threw);
}

// --- 輸出 ---
console.log('');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '\n      ' + r[2] : '');
const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
