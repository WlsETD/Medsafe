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

{
  const total = richmenu.AREAS.reduce((sum, a) => sum + a.bounds.width * a.bounds.height, 0);
  const expected = richmenu.DEFINITION.size.width * richmenu.DEFINITION.size.height;
  check('六宮格面積總和等於畫布面積（無空隙、無重疊）', total === expected,
    'total=' + total + ' expected=' + expected);
}
{
  // 兩兩檢查矩形是否重疊（AABB 相交測試）。
  const overlaps = [];
  for (let i = 0; i < richmenu.AREAS.length; i++) {
    for (let j = i + 1; j < richmenu.AREAS.length; j++) {
      const a = richmenu.AREAS[i].bounds, b = richmenu.AREAS[j].bounds;
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width
        && a.y < b.y + b.height && b.y < a.y + a.height;
      if (overlap) overlaps.push([i, j]);
    }
  }
  check('六宮格彼此不重疊', overlaps.length === 0, JSON.stringify(overlaps));
}
{
  const bad = richmenu.AREAS.filter(a => !a.action.label || a.action.label.length > 20);
  check('每格 label 存在且不超過 LINE 的 20 字上限', bad.length === 0);
}
{
  // 兩種合法型別：message（借用既有文字指令分支）與 uri（直接開免登入
  // 公開頁面，例如 check.html／schedule.html，不需要任何後端處理）。
  const bad = richmenu.AREAS.filter(a => {
    if (a.action.type === 'message') return !a.action.text;
    if (a.action.type === 'uri') return !a.action.uri || !a.action.uri.startsWith('https://');
    return true; // 其餘型別（例如 postback）目前不該出現在選單裡
  });
  check('每格都是 message（帶 text）或 uri（帶 https 連結），沒有其他型別',
    bad.length === 0, JSON.stringify(bad));
}
{
  const messageCount = richmenu.AREAS.filter(a => a.action.type === 'message').length;
  const uriCount = richmenu.AREAS.filter(a => a.action.type === 'uri').length;
  check('六宮格共 6 格：4 格文字指令 + 2 格免登入公開頁面連結',
    richmenu.AREAS.length === 6 && messageCount === 4 && uriCount === 2);
}
{
  const w = richmenu.DEFINITION.size.width, h = richmenu.DEFINITION.size.height;
  check('選單圖片尺寸符合 LINE 規格（2500x843 或 2500x1686）',
    w === 2500 && (h === 843 || h === 1686));
}

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

  check('建立選單那一步送出完整的 DEFINITION（六宮格區域）',
    calls[0].body === richmenu.DEFINITION);

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
