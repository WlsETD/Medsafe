// LINE Messaging API 的最小封裝：簽章驗證、reply、push。
//
// 【reply 與 push 的差別不只是技術，是成本】
// LINE 官方把「Messaging API 的 Reply API」列為不計費訊息，push 則計入方案則數
// （輕用量每月 200 則）。因此凡是「使用者剛剛傳了東西給我們、我們回應他」的
// 情境一律走 reply；只有系統主動找人（每日提醒卡、交互作用警示）才用 push。
// 這個區分決定了整個功能的月成本是 0 元還是四位數，寫程式時不可隨手互換。

const crypto = require('crypto');

const REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const LOADING_URL = 'https://api.line.me/v2/bot/chat/loading/start';

// 驗證 x-line-signature。
//
// 【必須用 rawBody，不可用 JSON.stringify(req.body)】
// 簽章是對「LINE 送出的原始位元組」做 HMAC。把解析後的物件重新序列化，
// 鍵的順序、空白、Unicode 逸出方式都可能與原文不同，於是驗證恆為失敗——
// 而症狀是「webhook 全部被擋，log 只寫 invalid signature」，
// 看起來像密鑰設錯，實際上密鑰是對的。
function verifySignature(rawBody, signature, channelSecret) {
  if (!rawBody || !signature || !channelSecret) return false;
  const expected = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  // 長度不同時 timingSafeEqual 會直接拋錯，因此先比長度。
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function callLine(url, token, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: JSON.stringify(payload)
  });

  if (res.ok) return { ok: true, status: res.status };

  const text = await res.text().catch(() => '');
  // 429 是「本月訊息額度用完」。這個失敗必須與一般錯誤分開回報：
  // 病患沒收到提醒，而系統以為推播成功，是這個功能最危險的失效模式——
  // 「沒收到提醒」絕不可以被病患理解成「今天不用吃藥」。
  return {
    ok: false,
    status: res.status,
    quotaExceeded: res.status === 429,
    body: text.slice(0, 500)
  };
}

// 回覆使用者剛剛送來的事件（免費）。replyToken 只能用一次、約 1 分鐘內有效。
function reply(token, replyToken, messages) {
  return callLine(REPLY_URL, token, {
    replyToken,
    messages: Array.isArray(messages) ? messages : [messages]
  });
}

// 主動推播（計費）。
function push(token, to, messages) {
  return callLine(PUSH_URL, token, {
    to,
    messages: Array.isArray(messages) ? messages : [messages]
  });
}

// 聊天室裡的「輸入中」動畫。
//
// 【為什麼需要它】
// 自由文字回報要等 LLM 抽詞，回覆會比按按鈕慢上一兩秒。對長輩來說，
// 送出後畫面毫無反應的那幾秒，會讓人以為沒送出去而重打一次——
// 於是同一件事被回報兩次。這個動畫的作用是把「系統在想」變成看得見的事。
//
// 不計費，且失敗也無所謂（純視覺），因此呼叫端不必等它、也不必處理錯誤。
// loadingSeconds 只接受 5 的倍數（5~60），給錯會 400。
function showLoading(token, userId, loadingSeconds = 10) {
  return callLine(LOADING_URL, token, { chatId: userId, loadingSeconds })
    .catch(() => ({ ok: false }));
}

function textMessage(text) {
  return { type: 'text', text };
}

// 帶 quick reply 按鈕的文字訊息。
// LINE 上限 13 顆，label 上限 20 字；超過會整則訊息被拒，因此在這裡就裁掉。
function textWithQuickReply(text, items) {
  const buttons = (items || []).slice(0, 13).map(it => ({
    type: 'action',
    action: {
      type: 'postback',
      label: String(it.label).slice(0, 20),
      data: it.data,
      displayText: it.displayText || it.label
    }
  }));
  const msg = { type: 'text', text };
  if (buttons.length) msg.quickReply = { items: buttons };
  return msg;
}

module.exports = { verifySignature, reply, push, showLoading, textMessage, textWithQuickReply };
