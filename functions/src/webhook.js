// LINE Webhook：官方帳號收到的所有事件都進到這裡。
//
// 這是本專案第一個對外開放、未經 Firebase Auth 的 HTTP 端點。它的存取控制
// 完全靠 x-line-signature 驗簽——除了 LINE 平台，沒有人有 Channel Secret，
// 因此沒有人能偽造出通得過驗簽的請求。驗簽失敗一律 403，不做任何後續處理。

const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');

const {
  LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, REGION
} = require('./config');
const lineApi = require('./line-api');
const bindings = require('./bindings');
const { recordTaken } = require('./adherence');
const { dayKey } = require('./taipei-time');
const flex = require('./flex');
const { claimPushSlot } = require('./push-lock');
const { dailyLockKey } = require('./reminder');

const HELP = [
  '您可以這樣使用：',
  '',
  '・輸入「藥箱」查看目前的用藥',
  '・收到每日提醒後，吃完請按卡片上的時段按鈕',
  '',
  '若要綁定帳號，請在 MedSafe 網頁的「LINE 提醒」中取得綁定碼，再傳給我。'
].join('\n');

// 綁定碼的形狀（8 碼、限定字母表）。用來判斷「這則訊息是不是在試綁定」，
// 避免把一句閒聊當成失敗的綁定碼、回一句「綁定碼無效」讓人一頭霧水。
const CODE_RE = new RegExp('^[' + bindings.ALPHABET + ']{' + bindings.CODE_LEN + '}$');

async function handleFollow(token, event) {
  const lineUserId = event.source && event.source.userId;
  if (lineUserId) {
    // 之前綁過、只是把帳號封鎖過的人，重新加好友就直接恢復，不必再綁一次
    const r = await bindings.reactivateByLineUserId(lineUserId);
    if (r.ok) {
      return lineApi.reply(token, event.replyToken,
        lineApi.textMessage('歡迎回來，用藥提醒已恢復。\n\n' + HELP));
    }
  }
  return lineApi.reply(token, event.replyToken, lineApi.textMessage(
    '這裡是 MedSafe 用藥提醒。\n\n請先在 MedSafe 網頁的「LINE 提醒」中取得 8 碼綁定碼，再把它傳給我，我就會開始提醒您吃藥。'
  ));
}

async function handleUnfollow(event) {
  const lineUserId = event.source && event.source.userId;
  if (!lineUserId) return;
  // 封鎖之後再推播只會白白消耗訊息額度（而且一定失敗），因此立刻停推。
  // 綁定關係本身不撤銷，反向索引也保留——重新加好友時可以直接恢復。
  await bindings.deactivateByLineUserId(lineUserId);
  logger.info('unfollow：已停止推播', { lineUserId });
}

// 綁定成功後順便把今天的用藥卡一起送出，而不是只回一句文字讓人等到
// 隔天早上才看得到效果——這對長輩的第一印象很重要：綁定這個動作
// 「馬上有用」，而不是一個看不出成效的設定步驟。
//
// 走 reply（免費）而非 push，且佔用與每日排程（reminder.js）相同的
// 冪等鎖：這裡送過一次，07:30 的排程就會因為鎖已存在而跳過，
// 不會重複推播幾乎一樣的卡片，也不會多消耗一次月配額。
async function replyWithTodayCard(token, replyToken, username) {
  const welcome = '綁定成功。\n\n之後每天早上會傳一張當日用藥卡給您，吃完按一下就完成回報。\n\n' + HELP;

  try {
    const snap = await admin.firestore().collection('patient_data').doc(username).get();
    const reminders = snap.exists && Array.isArray(snap.data().reminders) ? snap.data().reminders : [];
    if (!reminders.length) {
      return lineApi.reply(token, replyToken, lineApi.textMessage(welcome));
    }

    const day = dayKey();
    const claimed = await claimPushSlot(dailyLockKey(username, day));
    if (!claimed) {
      // 今天已經推過了（例如同一天重新綁定）——不重複附卡，只回文字
      return lineApi.reply(token, replyToken, lineApi.textMessage(welcome));
    }

    const name = (snap.data().profile && snap.data().profile.name) || username;
    const sorted = reminders.slice().sort((a, b) => String(a.time).localeCompare(String(b.time)));
    const card = flex.dailyReminderCard(name, day, sorted);
    return lineApi.reply(token, replyToken, [lineApi.textMessage(welcome), card]);
  } catch (e) {
    // 附卡失敗不可讓整個綁定看起來失敗——綁定本身（Firestore 寫入）已經成功了，
    // 只是少了這張錦上添花的卡片，仍要回覆確認訊息。
    logger.error('綁定成功但附卡失敗', { username, error: e.message });
    return lineApi.reply(token, replyToken, lineApi.textMessage(welcome));
  }
}

async function handleText(token, event) {
  const lineUserId = event.source && event.source.userId;
  const text = String(event.message.text || '').trim();

  // ── 綁定碼 ──
  const candidate = text.toUpperCase().replace(/[\s-]/g, '');
  if (CODE_RE.test(candidate)) {
    const r = await bindings.redeemLinkCode(candidate, lineUserId);
    if (r.ok) {
      logger.info('綁定成功', { username: r.username });
      return replyWithTodayCard(token, event.replyToken, r.username);
    }
    const why = {
      'not-found': '這組綁定碼不存在，請確認是否輸入正確。',
      'expired': '這組綁定碼已超過 10 分鐘失效，請回網頁重新產生一組。',
      'used': '這組綁定碼已經使用過了，請回網頁重新產生一組。'
    }[r.reason] || '綁定失敗，請稍後再試。';
    return lineApi.reply(token, event.replyToken, lineApi.textMessage(why));
  }

  // ── 以下功能都需要已綁定 ──
  const user = lineUserId ? await bindings.findByLineUserId(lineUserId) : null;
  if (!user) {
    return lineApi.reply(token, event.replyToken, lineApi.textMessage(
      '您還沒有綁定帳號。\n\n請在 MedSafe 網頁的「LINE 提醒」中取得 8 碼綁定碼，再傳給我。'
    ));
  }

  // ── 藥箱查詢 ──
  //
  // 走 reply 而非 push，所以病患想查幾次都不計費（LINE 明文把 Reply API
  // 列為免費訊息）。把「隨時可查」設計成零成本，才能把付費的推播額度
  // 留給真正需要主動打斷對方的事——每日提醒與交互作用警示。
  if (/藥箱|藥|用藥|吃什麼/.test(text)) {
    const snap = await admin.firestore().collection('patient_data').doc(user.username).get();
    if (!snap.exists) {
      return lineApi.reply(token, event.replyToken, lineApi.textMessage('查無您的用藥資料。'));
    }
    const data = snap.data();
    const meds = Array.isArray(data.medications) ? data.medications : [];
    if (!meds.length) {
      return lineApi.reply(token, event.replyToken, lineApi.textMessage('您目前沒有登記中的用藥。'));
    }

    // 引擎與規則庫加起來約 355 KB，載入要花時間，因此只在真的要用時才載，
    // 不讓綁定與回報這兩條高頻路徑跟著付冷啟動的代價。
    const ddi = require('./ddi');
    const result = ddi.analyze(meds);
    const worthy = ddi.pushWorthyFindings(result);

    const hospitals = [...new Set(meds.map(m => m.hospital).filter(Boolean))];
    const lines = [
      '您目前有 ' + meds.length + ' 種藥' + (hospitals.length ? '，來自 ' + hospitals.length + ' 家醫院' : ''),
      ''
    ];
    for (const m of meds) {
      lines.push('・' + (m.zhName || m.name) + '　' + (m.dosage || '') + (m.hospital ? '（' + m.hospital + '）' : ''));
    }
    if (worthy.length) {
      lines.push('', '⚠️ 其中有 ' + worthy.length + ' 組需要注意的交互作用：');
      for (const f of ddi.decorate(worthy, meds).slice(0, 3)) {
        lines.push('・' + f.display.a.name + ' ＋ ' + f.display.b.name
          + '（' + (f.severityZh || f.severity) + '）');
      }
      lines.push('', '請勿自行停藥，回診時向醫師或藥師確認。');
    }
    if (result.unevaluable && result.unevaluable.length) {
      // 「無法評估」與「沒有交互作用」是兩件事，不可合併成一句「安全」。
      // 這正是稽核報告 P0-3 抓到過的錯誤形狀（見 ddi-engine.js 註解）。
      lines.push('', '另有 ' + result.unevaluable.length + ' 種藥系統無法判讀，不代表沒有交互作用。');
    }
    return lineApi.reply(token, event.replyToken, lineApi.textMessage(lines.join('\n')));
  }

  return lineApi.reply(token, event.replyToken, lineApi.textMessage(HELP));
}

async function handlePostback(token, event) {
  const lineUserId = event.source && event.source.userId;
  const params = new URLSearchParams(event.postback.data || '');
  if (params.get('action') !== 'taken') return;

  const user = lineUserId ? await bindings.findByLineUserId(lineUserId) : null;
  if (!user) {
    return lineApi.reply(token, event.replyToken,
      lineApi.textMessage('您還沒有綁定帳號，無法回報。'));
  }

  const time = params.get('time');
  // 卡片上帶的是「推播當下的日期」。刻意不改用「現在的日期」——
  // 長輩很可能在午夜之後才按下早上那張卡，用現在的日期會把它記到隔天，
  // 於是昨天永遠顯示漏吃、今天憑空多一筆。
  const day = params.get('day') || dayKey();

  const r = await recordTaken(user.username, day, time);

  if (!r.persisted) {
    const why = {
      'no-record': '查無您的病歷資料，回報未儲存。',
      'slot-gone': '這個時段的用藥已經有異動，請開啟藥箱確認目前的排程。'
    }[r.reason] || '回報未能儲存，請稍後再試。';
    return lineApi.reply(token, event.replyToken, lineApi.textMessage(why));
  }

  const msg = r.already
    ? '這個時段先前已經回報過了（' + time + '　' + r.text + '）'
    : '已記錄 ' + time + ' 的用藥　' + r.text;
  return lineApi.reply(token, event.replyToken, lineApi.textMessage(msg));
}

exports.lineWebhook = onRequest(
  {
    region: REGION,
    secrets: [LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN],
    // webhook 不需要高併發，但冷啟動會讓長輩等待。1 個常駐執行個體
    // 在免費額度內，換到的是「傳出去大概一秒內就有回應」。
    minInstances: 0,
    maxInstances: 5,
    cors: false
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    const secret = LINE_CHANNEL_SECRET.value();
    const token = LINE_CHANNEL_ACCESS_TOKEN.value();

    if (!lineApi.verifySignature(req.rawBody, req.get('x-line-signature'), secret)) {
      logger.warn('x-line-signature 驗證失敗，已拒絕');
      res.status(403).send('Forbidden');
      return;
    }

    const events = (req.body && req.body.events) || [];

    for (const event of events) {
      try {
        if (event.type === 'message' && event.message && event.message.type === 'text') {
          await handleText(token, event);
        } else if (event.type === 'postback') {
          await handlePostback(token, event);
        } else if (event.type === 'follow') {
          await handleFollow(token, event);
        } else if (event.type === 'unfollow') {
          await handleUnfollow(event);
        }
      } catch (e) {
        // 單一事件失敗不影響同一批的其他事件。
        // 且無論如何都回 200——回非 2xx 會讓 LINE 重送整批，
        // 已經處理成功的那幾則就會被重做一次。
        logger.error('事件處理失敗', { type: event.type, error: e.message, stack: e.stack });
      }
    }

    res.status(200).json({ ok: true });
  }
);
