// LINE Webhook：官方帳號收到的所有事件都進到這裡。
//
// 這是本專案第一個對外開放、未經 Firebase Auth 的 HTTP 端點。它的存取控制
// 完全靠 x-line-signature 驗簽——除了 LINE 平台，沒有人有 Channel Secret，
// 因此沒有人能偽造出通得過驗簽的請求。驗簽失敗一律 403，不做任何後續處理。

const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');

const {
  LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, OPENAI_API_KEY, REGION
} = require('./config');
const lineApi = require('./line-api');
const bindings = require('./bindings');
const { recordTaken } = require('./adherence');
const { dayKey } = require('./taipei-time');
const flex = require('./flex');
const { claimPushSlot, releasePushSlot } = require('./push-lock');
const { dailyLockKey } = require('./reminder');

const HELP = [
  '您可以這樣使用：',
  '',
  '・直接用說的回報，例如「早上的藥吃了」',
  '・輸入「藥箱」查看目前的用藥',
  '・收到每日提醒後，吃完也可以按卡片上的時段按鈕',
  '',
  '若要綁定帳號，請在 MedSafe 網頁的「LINE 提醒」中取得綁定碼，再傳給我。'
].join('\n');

// 綁定碼的形狀（8 碼、限定字母表）。用來判斷「這則訊息是不是在試綁定」，
// 避免把一句閒聊當成失敗的綁定碼、回一句「綁定碼無效」讓人一頭霧水。
const CODE_RE = new RegExp('^[' + bindings.ALPHABET + ']{' + bindings.CODE_LEN + '}$');

// 「查藥箱」的意圖。
//
// 【為什麼從 /藥箱|藥|用藥|吃什麼/ 收緊成這樣】
// 原本那個 `|藥|` 會吃掉幾乎每一句跟藥有關的話——「剛吃完血壓藥」含「藥」字，
// 於是自由文字回報永遠走不到 NLU，全部被當成查詢藥箱。加了 NLU 之後，
// 這個過寬的比對從「無害」變成「讓新功能完全失效」。
// 查詢是明確的指令式說法，回報是敘述句，因此改為錨定整句。
const CABINET_RE = /^(藥箱|我的藥|我的用藥|用藥清單|查藥|查用藥|吃什麼藥?|有哪些藥)[？?。!！]*$/;

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
  if (CABINET_RE.test(text)) {
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

  // ── 自由文字回報（LLM 語意理解）──
  //
  // 【擺在最後一個分支，而不是最前面】
  // 綁定碼與藥箱查詢都是形狀明確、判斷零成本、且結果確定的路徑。
  // 讓它們先走完，LLM 只接手真正無法用規則判斷的句子——
  // 既省下每則訊息的 API 成本，也讓既有功能不因 LLM 故障而一起壞掉。
  return handleFreeText(token, event, user, text);
}

// 按鈕流程的 fallback 訊息。NLU 失敗時一律退回這裡，
// 而不是回一句「我不懂」讓使用者無路可走。
const FALLBACK = '我不太確定您的意思。\n\n您可以按每日提醒卡上的時段按鈕回報，或輸入「藥箱」查看用藥。';

async function handleFreeText(token, event, user, text) {
  const lineUserId = event.source && event.source.userId;

  // 先讓聊天室出現「輸入中」，再去等 LLM。不 await——這只是視覺效果，
  // 讓它跟 LLM 呼叫並行，不要為了一個動畫多花掉回覆預算裡的往返時間。
  if (lineUserId) lineApi.showLoading(token, lineUserId);

  const snap = await admin.firestore().collection('patient_data').doc(user.username).get();
  if (!snap.exists) {
    return lineApi.reply(token, event.replyToken, lineApi.textMessage('查無您的用藥資料。'));
  }
  const patientData = snap.data();

  // NLU 只在真的要用時才載——與藥箱查詢載入 DDI 引擎的理由相同。
  const nlu = require('./nlu');
  const r = await nlu.processUserInput(text, patientData);

  if (r.status === 'error') {
    // LLM 掛掉、額度用完、逾時——一律退回按鈕流程。
    // 【不可以在這裡道歉完就結束】使用者是來回報吃藥的，
    // 必須告訴他還有另一條路可以完成同一件事。
    logger.error('NLU 失敗，已退回按鈕流程', { username: user.username, error: r.error });
    return lineApi.reply(token, event.replyToken, lineApi.textMessage(FALLBACK));
  }

  if (r.status === 'no-extraction') {
    return lineApi.reply(token, event.replyToken, lineApi.textMessage(FALLBACK));
  }

  const day = dayKey();
  const lines = [];

  // ── 寫入高信心度的回報 ──
  for (const item of r.toRecord) {
    const res = await recordTaken(user.username, day, item.slot.time);
    const name = item.med.zhName || item.med.name;
    if (!res.persisted) {
      lines.push('・' + name + '　回報未能儲存，請改用提醒卡上的按鈕');
    } else if (res.already) {
      lines.push('・' + item.slot.time + '　' + res.text + '（先前已回報過）');
    } else {
      lines.push('✓ ' + item.slot.time + '　' + res.text);
    }
  }
  if (lines.length) lines.unshift('已為您記錄：', '');

  // ── 說了「沒吃／不確定」的：只回覆，不寫入（理由見 nlu.js）──
  for (const n of r.notRecorded) {
    const name = n.med.zhName || n.med.name;
    if (n.reason === 'no-slot') {
      lines.push('', '「' + name + '」目前沒有設定提醒時段，無法回報。');
    } else {
      lines.push('', '「' + name + '」（' + n.slot.time + '）目前仍是未回報的狀態。');
    }
  }

  // ── 不認得的藥名：據實說，不猜最接近的那個 ──
  if (r.unmatched.length) {
    lines.push('', '您提到的「' + r.unmatched.join('」「') + '」不在您目前的用藥清單裡。');
  }

  // ── 需要追問的：用 quick reply 讓使用者從候選清單挑 ──
  //
  // 【所有按鈕都送出既有的 action=taken postback】
  // 「挑一個時段」在語意上就是「按下那個時段的已服用」，因此直接複用
  // handlePostback 那條已經在跑、也已經有去重與 slot 檢查的路徑，
  // 不為了 quick reply 另開一種 postback 型別。
  if (r.confirm.length) {
    const c = r.confirm[0];
    const items = [];
    let question = '';

    if (c.kind === 'pick-drug') {
      question = '您說的「' + c.said + '」是指哪一個？';
      for (const med of c.options) {
        const name = med.zhName || med.name;
        const slot = (patientData.reminders || []).find(x => String(x.text || '').includes(name));
        if (!slot) continue;
        items.push({
          label: name,
          data: 'action=taken&day=' + day + '&time=' + encodeURIComponent(slot.time),
          displayText: name + ' 已服用'
        });
      }
    } else if (c.kind === 'pick-slot') {
      question = '「' + (c.med.zhName || c.med.name) + '」有多個時段，請問是哪一次？';
      for (const slot of c.slots) {
        items.push({
          label: slot.time,
          data: 'action=taken&day=' + day + '&time=' + encodeURIComponent(slot.time),
          displayText: slot.time + ' 已服用'
        });
      }
    } else {
      question = '請確認是這一項嗎？';
      items.push({
        label: c.slot.time + ' ' + (c.med.zhName || c.med.name),
        data: 'action=taken&day=' + day + '&time=' + encodeURIComponent(c.slot.time),
        displayText: c.slot.time + ' 已服用'
      });
    }

    if (items.length) {
      if (lines.length) lines.push('');
      lines.push(question);
      return lineApi.reply(token, event.replyToken,
        lineApi.textWithQuickReply(lines.join('\n'), items));
    }
  }

  if (!lines.length) {
    return lineApi.reply(token, event.replyToken, lineApi.textMessage(FALLBACK));
  }
  return lineApi.reply(token, event.replyToken, lineApi.textMessage(lines.join('\n').trim()));
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

// 事件層級的冪等鎖。
//
// 【為什麼一定要有】
// LINE 在收不到 200（或收得太慢）時會重送整批事件。自由文字回報要等 LLM，
// 比按按鈕慢，因此真的會撞上重送。而本專案的病歷設計是不可刪除的——
// 重複寫入一筆服藥紀錄無法用刪除補救，只能不要讓它發生。
//
// recordTaken() 自身雖然有 slotKey 去重（同一時段按兩次會回 already），
// 但那只擋得住「同一個 slot」。重送發生在更外層：整批事件被重放，
// 期間病患若剛好改了排程，第二次重放就可能落到不同的 slot 而寫成兩筆。
// 因此去重要做在事件本身，不能只靠下游。
//
// 沿用 push-lock 的 create()-as-lock 與 line_push_log 集合：該集合在
// firestore.rules 中已對所有前端關閉，因此這個新用途不需要動任何規則，
// 也就不需要為它補一輪 rules 測試。前綴 evt: 與推播鎖的鍵區隔開來。
async function claimEvent(event) {
  const id = event.webhookEventId;
  // 舊版 LINE 事件沒有這個欄位。沒有 id 就無從去重——此時仍要處理，
  // 因為「因為擋不住重複就乾脆不回報」比重複回報更糟。
  if (!id) return true;
  return claimPushSlot('evt:' + id);
}

exports.lineWebhook = onRequest(
  {
    region: REGION,
    secrets: [LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, OPENAI_API_KEY],
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
        // unfollow 不寫任何病歷，重放無害；其餘一律先過冪等鎖。
        if (event.type !== 'unfollow' && !(await claimEvent(event))) {
          logger.info('重送的事件，已略過', { id: event.webhookEventId, type: event.type });
          continue;
        }

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
        // 失敗時放掉冪等鎖，否則「失敗一次就永久不再受理這個事件」——
        // 那比重複處理更糟（見 push-lock.js 的同一段推理）。
        if (event.webhookEventId) await releasePushSlot('evt:' + event.webhookEventId);
      }
    }

    res.status(200).json({ ok: true });
  }
);
