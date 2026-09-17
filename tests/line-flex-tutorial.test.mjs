// flex.js 的使用說明圖文教學卡（tutorialCarousel）測試。
//
// 這份測試守的是：
//   一、卡片內容從 richmenu.buildAreas() 取得，不是自己重複定義一份——
//       兩邊的 action（message/uri）必須完全一致，否則教學卡點下去
//       跟選單按下去會是不同行為。
//   二、「使用說明」本身不出現在教學卡裡（不必教自己）。
//   三、圖片一律是 https 網址（LINE Flex image 元件不接受其他格式）。
//   四、carousel 結構與 altText 存在，符合 LINE Flex 規格的最低要求。
//
// 不需要 Firestore 模擬器、不打真的網路。
//
// 執行：node tests/line-flex-tutorial.test.mjs

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const flex = require('../functions/src/flex.js');
const richmenu = require('../functions/src/richmenu.js');

const results = [];
const check = (name, cond, detail) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (detail || '')]);

delete process.env.LIFF_ID; // 與 richmenu.test.mjs 同樣先固定在「未設定」狀態測

const msg = flex.tutorialCarousel();
const areas = richmenu.buildAreas();
const bubbles = msg.contents.contents;

check('回傳型別為 flex，且帶 altText', msg.type === 'flex' && typeof msg.altText === 'string' && msg.altText.length > 0);
check('contents 是 carousel', msg.contents.type === 'carousel');
check('卡片數等於六宮格扣掉「使用說明」＝ 5 張',
  bubbles.length === 5, 'got ' + bubbles.length);
check('沒有「使用說明」自己的教學卡',
  !bubbles.some(b => b.body.contents[0].text === '使用說明'));

for (const b of bubbles) {
  const label = b.body.contents[0].text;
  const area = areas.find(a => a.action.label === label);
  check('教學卡「' + label + '」在 buildAreas() 找得到對應格', !!area);
  if (!area) continue;

  const btn = b.footer.contents[0].action;
  if (area.action.type === 'uri') {
    check('「' + label + '」按鈕與選單同為 uri 且網址一致',
      btn.type === 'uri' && btn.uri === area.action.uri);
  } else {
    check('「' + label + '」按鈕與選單同為 message 且文字一致',
      btn.type === 'message' && btn.text === area.action.text);
  }

  check('「' + label + '」的圖片是 https 網址', b.hero.type === 'image' && /^https:\/\//.test(b.hero.url));
}

// --- 輸出 ---
console.log('');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '\n      ' + r[2] : '');
const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
