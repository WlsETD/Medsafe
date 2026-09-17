// LINE Webhook：官方帳號收到的所有事件都進到這裡。
//
// 這是本專案第一個對外開放、未經 Firebase Auth 的 HTTP 端點。它的存取控制
// 完全靠 x-line-signature 驗簽——除了 LINE 平台，沒有人有 Channel Secret，
// 因此沒有人能偽造出通得過驗簽的請求。驗簽失敗一律 403，不做任何後續處理。

const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');

const {
  LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, OPENAI_API_KEY, REGION, LIFF_ID, FAMILY_LIFF_ID
} = require('./config');
const lineApi = require('./line-api');
const bindings = require('./bindings');
const { recordTaken } = require('./adherence');
const { dayKey } = require('./taipei-time');
const flex = require('./flex');
const { claimPushSlot, releasePushSlot } = require('./push-lock');
const { dailyLockKey } = require('./reminder');
const richmenu = require('./richmenu');

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

// 「服藥時間表」的意圖。與 CABINET_RE 同樣錨定整句，理由相同——
// 這個按鈕原本是 uri 直接開免登入的 schedule.html（列印用工具），
// 但那是給沒有帳號的訪客用的空白表單；已綁定的病患點下去期待看到的是
// 「今天實際要吃的藥」，所以改回跟每日提醒卡（reminder.js）同一張卡片，
// 隨時查詢、隨時可以直接按按鈕回報，不必等到隔天早上 07:30。
// schedule.html 本身（免登入、可列印）仍保留給網頁版使用，這裡只是
// LINE 內的路徑改了。
const SCHEDULE_RE = /^(服藥時間表|今日服藥時間表|今日用藥時間表|用藥時間表|時間表|提醒時間|吃藥時間)[？?。!！]*$/;

// 呼叫選單的意圖。與 CABINET_RE 同樣錨定整句，理由相同。
const MENU_RE = /^(選單|menu|說明|help|功能|你會什麼)[？?。!！]*$/i;

// 「回報不適」意圖（Phase 4）：按鈕觸發，兩步式——先請病患描述，
// 下一則自由文字才是真正要轉達給醫師的內容。與 CABINET_RE 同樣錨定整句。
//
// 【為什麼要兩步，不能像藥箱／時間表一樣一步到位】
// 藥箱／時間表回覆的是系統已經有的資料；回報不適要傳的是病患這次想說的話，
// 而 LINE 的 message action 只能送出固定文字（按鈕本身寫的那句），沒辦法
// 讓使用者在點擊的同一動作中夾帶自訂內容。因此設計成：按下「回報不適」→
// Bot 回覆請描述 → 下一則自由文字才是內容，寫進 conversations（與網頁版
// 留言板同一份資料、同一種形狀，見 forwardSymptomReport() 的說明），
// 讓醫師在既有的留言板介面看得到，不必另外開一個「不適回報」的獨立系統。
//
// 【為什麼不直接讓自由文字 NLU 判斷「這是不是在講不適」】
// 那樣任何一句「有點不舒服」都可能被誤判要不要轉發給醫師，不確定性太高。
// 兩步式讓病患自己明確決定「這句話是要轉給醫師看的」，不是系統用猜的——
// 與本專案一貫「系統不做醫療判斷」的立場一致。
const SYMPTOM_RE = /^回報不適[？?。!！]*$/;

// 「等待病患描述不適」的短效旗標，存在 line_users/{lineUserId} 這份文件上
// （本來就是 Admin SDK 專用、對前端全面關閉的集合，見 firestore.rules 的
// LINE 一節），不另開新集合。10 分鐘內收到的下一則自由文字視為回報內容，
// 逾時則正常落回 NLU／其餘分支——避免「按過一次之後，這支 LINE 從此把
// 所有話都當成回報不適」這種靜默改變行為的地雷。
const SYMPTOM_WAIT_MS = 10 * 60 * 1000;

function startSymptomReport(token, event, lineUserId) {
  admin.firestore().collection('line_users').doc(lineUserId)
    .set({ awaitingSymptomUntil: Date.now() + SYMPTOM_WAIT_MS }, { merge: true })
    .catch(e => logger.error('回報不適旗標寫入失敗', { lineUserId, error: e.message }));
  return lineApi.reply(token, event.replyToken, lineApi.withQuickReply(
    lineApi.textMessage('請直接描述您的不適，我會轉達給您的主治醫師。例如：「頭很暈」、「吃藥後想吐」。'),
    menuItems()));
}

// 這位病患目前的主治醫師，跟 patient.html 的 loadAppointments() 用同一套
// 判斷：優先看「最近一筆進行中的掛號」（新制），查無掛號才退回
// patient_data.assignedDoctor（既有病患的過渡欄位）——改一邊要同步改另一邊，
// 否則網頁版顯示的主治醫師跟 LINE 這裡轉發訊息的對象會對不上。
async function currentDoctorOf(username) {
  const db = admin.firestore();
  const snap = await db.collection('appointments').where('patient', '==', username).get();
  const active = snap.docs.map(d => d.data())
    .filter(a => a.status === 'booked' || a.status === 'arrived');
  if (active.length) {
    const keyOf = (a) => a.dateKey
      || (a.scheduledAt && a.scheduledAt.toDate ? dayKey(a.scheduledAt.toDate()) : '');
    active.sort((x, y) => String(keyOf(y)).localeCompare(String(keyOf(x))));
    if (active[0].doctor) return active[0].doctor;
  }
  const pd = await db.collection('patient_data').doc(username).get();
  return (pd.exists && pd.data().assignedDoctor) || null;
}

// 把病患剛描述的不適寫進 conversations——與 js/chatStore.js 的 addMessage()
// 讀寫同一份集合、同一種文件形狀（conversations/{patient} 的
// patient/doctor/participants，子集合 messages 的 from/text/at）。
// 兩處若形狀不同步，網頁版留言板會漏顯示這一則、或醫師端的存取規則
// （靠 participants 判斷）擋下本該看得到的對話。
//
// 內容前面加註記，讓事後在網頁版留言板看歷史紀錄的人分得出這則是
// LINE 自動轉達的、不是病患自己在網頁上打的——與 adherenceLog 標示為
// 病患自述、db-service.js 各處「標明資料來源」的一貫做法相同。
const SYMPTOM_PREFIX = '【LINE 回報不適】';

async function forwardSymptomReport(token, event, user, lineUserId, text) {
  await admin.firestore().collection('line_users').doc(lineUserId)
    .update({ awaitingSymptomUntil: admin.firestore.FieldValue.delete() }).catch(() => {});

  const doctor = await currentDoctorOf(user.username);
  const db = admin.firestore();
  const convRef = db.collection('conversations').doc(user.username);
  const convSnap = await convRef.get();
  if (!convSnap.exists) {
    const participants = [user.username];
    if (doctor) participants.push(doctor);
    await convRef.set({
      patient: user.username, doctor: doctor || null, participants,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } else if (doctor && !convSnap.data().participants.includes(doctor)) {
    // 既有對話串換了主治醫師（轉診／換醫師）：把新醫師加進 participants，
    // 否則這則新轉達的訊息，新醫師的規則權限讀不到自己的病患對話。
    // 舊醫師仍保留在名單內——歷史對話本來就是他當時參與的紀錄，不可抹除。
    await convRef.update({
      participants: admin.firestore.FieldValue.arrayUnion(doctor)
    });
  }
  await convRef.collection('messages').add({
    from: 'patient',
    text: SYMPTOM_PREFIX + text,
    at: admin.firestore.FieldValue.serverTimestamp()
  });

  const msg = doctor
    ? '已將您的狀況轉達給主治醫師，請留意後續回覆。若情況緊急，請直接撥打 119 或立即就醫。'
    : '已記錄您的狀況，但目前查無主治醫師可轉達——請先於 MedSafe 網頁完成掛號、建立醫病關係。若情況緊急，請直接撥打 119 或立即就醫。';
  return lineApi.reply(token, event.replyToken,
    lineApi.withQuickReply(lineApi.textMessage(msg), menuItems()));
}

// 「線上預約」——與 CABINET_RE／MENU_RE 同樣錨定整句，理由相同。
// 掛號本身完全重用 patient.html 既有的 activeView === 'appointments'
// 區塊與 DbService.appointments，沒有另外刻一份對話式掛號邏輯
// （見 linebot.md §4.2：對話式重刻只會多一份要跟 firestore.rules
// 保持一致的邏輯，卻不會更安全）。LIFF_ID 未設定時（Phase 0 尚未
// 走完）退回原本的「開發中」文字，不給一個開不了的死連結。
const BOOKING_RE = /^(預約|線上預約)[？?。!！]*$/;
function bookingReply() {
  const liffId = LIFF_ID.value();
  if (!liffId) {
    return lineApi.textMessage('「線上預約」還在開發中，麻煩您先照原本的方式掛號，敬請期待。');
  }
  const url = 'https://liff.line.me/' + liffId + '?view=appointments';
  return lineApi.withQuickReply(
    lineApi.textMessage('可以直接在下面開啟掛號頁——選科別、輸入醫師帳號、選日期送出即可，取消掛號也在同一頁。'),
    [{ label: '前往掛號', uri: url }, ...menuItems()]
  );
}

// 選單按鈕：只列出「按下去會有像樣回應」的功能——「查藥箱」「線上預約」
// 是真的能用（後者視 LIFF_ID 有無設定，見 BOOKING_RE／bookingReply），
// 「回報不適」是誠實的開發中提示（見上），不是按了沒反應的死按鈕。
// Phase 4 做完後，把「回報不適」也換成真正的功能即可，選單本身不用改。
//
// text 而非 data：按下去等同使用者自己打了這句話送出，直接借用既有的
// 文字指令分支（見 line-api.js quickReplyItems 的說明），新增選單項目
// 不需要另外處理 postback。
//
// 「完整藥箱」是 Phase 0（LIFF 身分橋接）做完後新加的：文字版「查藥箱」
// 摘要（見下方 CABINET_RE 分支）維持 Reply、免費、隨時可查；這個按鈕另外
// 開 LIFF 版 patient.html，同一份頁面、同一套 firestore.rules，只是多了
// 完整的用藥時間軸與所有 DDI 警示細節。兩層設計理由見 linebot.md §5.2。
// LIFF_ID 未設定時（尚未走完 Phase 0）不顯示這個按鈕，而不是給一個開不了的死連結。
function menuItems() {
  const items = [
    { label: '查藥箱', text: '藥箱' },
    { label: '線上預約', text: '預約' },
    { label: '回報不適', text: '回報不適' },
    { label: '綁定家屬', uri: richmenu.SITE_ORIGIN + '/family-bind-help.html' },
    { label: '服藥時間表', text: '服藥時間表' }
  ];
  const liffId = LIFF_ID.value();
  if (liffId) {
    items.splice(1, 0, { label: '完整藥箱', uri: 'https://liff.line.me/' + liffId });
  }
  return items;
}

async function handleFollow(token, event) {
  const lineUserId = event.source && event.source.userId;
  if (lineUserId) {
    // 之前綁過、只是把帳號封鎖過的人，重新加好友就直接恢復，不必再綁一次
    const r = await bindings.reactivateByLineUserId(lineUserId);
    if (r.ok) {
      return lineApi.reply(token, event.replyToken,
        lineApi.withQuickReply(lineApi.textMessage('歡迎回來，用藥提醒已恢復。\n\n' + HELP), menuItems()));
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
      return lineApi.reply(token, replyToken, lineApi.withQuickReply(lineApi.textMessage(welcome), menuItems()));
    }

    const day = dayKey();
    const claimed = await claimPushSlot(dailyLockKey(username, day));
    if (!claimed) {
      // 今天已經推過了（例如同一天重新綁定）——不重複附卡，只回文字
      return lineApi.reply(token, replyToken, lineApi.withQuickReply(lineApi.textMessage(welcome), menuItems()));
    }

    const name = (snap.data().profile && snap.data().profile.name) || username;
    const sorted = reminders.slice().sort((a, b) => String(a.time).localeCompare(String(b.time)));
    // quickReply 只在一次回覆的「最後一則」訊息上生效，因此掛在卡片上，不是文字訊息上。
    const card = lineApi.withQuickReply(flex.dailyReminderCard(name, day, sorted), menuItems());
    return lineApi.reply(token, replyToken, [lineApi.textMessage(welcome), card]);
  } catch (e) {
    // 附卡失敗不可讓整個綁定看起來失敗——綁定本身（Firestore 寫入）已經成功了，
    // 只是少了這張錦上添花的卡片，仍要回覆確認訊息。
    logger.error('綁定成功但附卡失敗', { username, error: e.message });
    return lineApi.reply(token, replyToken, lineApi.withQuickReply(lineApi.textMessage(welcome), menuItems()));
  }
}

// 家屬邀請碼核銷成功後的回覆。刻意不含任何醫療內容（用藥、DDI、掛號等）——
// 這則訊息走的是 Bot 文字回覆（Admin SDK），而顯示病歷內容的路徑一律
// 必須走 LIFF + Custom Token 讓 firestore.rules 照常生效（見 CLAUDE.md）。
// 這裡只確認綁定本身成功，實際內容留給家屬自己打開 LIFF 頁面查看。
async function replyFamilyBound(token, replyToken, outcome) {
  const label = outcome.relationshipLabel ? '（' + outcome.relationshipLabel + '）' : '';
  const lines = [
    '已成功連結為家屬檢視身分' + label + '。',
    '之後可以透過家屬檢視頁面查看用藥、交互作用警示、掛號時間與服藥回報。'
  ];
  const liffId = FAMILY_LIFF_ID.value();
  if (liffId) {
    lines.push('', 'https://liff.line.me/' + liffId);
  } else {
    // 未設定家屬 LIFF App 時（尚未走完部署設定）不給一個開不了的死連結，
    // 跟 bookingReply()／menuItems() 對 LIFF_ID 未設定時的處理是同一個原則。
    lines.push('', '（家屬檢視頁面尚未開通，請洽系統管理者）');
  }
  return lineApi.reply(token, replyToken, lineApi.textMessage(lines.join('\n')));
}

// 家屬帳號誤觸病患專屬指令時的回覆。不查詢、不判斷意圖，一律導去
// 家屬檢視頁面——這支帳號沒有自己的 patient_data，任何往下的路徑
// 都只會得到「查無資料」或更糟的誤判，不如在這裡就說清楚。
function replyFamilyRedirect(token, replyToken) {
  const liffId = FAMILY_LIFF_ID.value();
  const lines = ['這支帳號是家屬檢視身分，用藥、交互作用警示與掛號時間請開啟家屬檢視頁面查看，無法在對話中查詢。'];
  if (liffId) lines.push('', 'https://liff.line.me/' + liffId);
  return lineApi.reply(token, replyToken, lineApi.textMessage(lines.join('\n')));
}

async function handleText(token, event) {
  const lineUserId = event.source && event.source.userId;
  const text = String(event.message.text || '').trim();

  // ── 綁定碼／家屬邀請碼 ──
  //
  // 兩種碼共用同一種字母表與長度（見 firestore.rules 家屬邀請碼一節：
  // 刻意用獨立集合，不是共用同一份文件形狀），因此格式比對只需要一次，
  // 核銷時先試病患本人綁定碼，找不到再試家屬邀請碼——兩邊都 not-found
  // 才真的是「這組碼不存在」。
  const candidate = text.toUpperCase().replace(/[\s-]/g, '');
  if (CODE_RE.test(candidate)) {
    const r = await bindings.redeemLinkCode(candidate, lineUserId);
    if (r.ok) {
      logger.info('綁定成功', { username: r.username });
      return replyWithTodayCard(token, event.replyToken, r.username);
    }
    if (r.reason !== 'not-found') {
      const why = {
        'expired': '這組綁定碼已超過 10 分鐘失效，請回網頁重新產生一組。',
        'used': '這組綁定碼已經使用過了，請回網頁重新產生一組。'
      }[r.reason] || '綁定失敗，請稍後再試。';
      return lineApi.reply(token, event.replyToken, lineApi.textMessage(why));
    }

    const fr = await bindings.redeemFamilyInviteCode(candidate, lineUserId);
    if (fr.ok) {
      logger.info('家屬邀請碼核銷成功', { patient: fr.patient, familyUsername: fr.familyUsername });
      return replyFamilyBound(token, event.replyToken, fr);
    }
    if (fr.reason !== 'not-found') {
      const why2 = {
        'expired': '這組邀請碼已超過 30 分鐘失效，請請病患重新產生一組。',
        'used': '這組邀請碼已經使用過了，請請病患重新產生一組。',
        'self-invite': '不能用病患自己的 LINE 帳號核銷自己的家屬邀請碼。',
        'already-bound-other-role': '這支 LINE 帳號已經綁定為其他身分，無法再核銷家屬邀請碼。'
      }[fr.reason] || '核銷失敗，請稍後再試。';
      return lineApi.reply(token, event.replyToken, lineApi.textMessage(why2));
    }

    return lineApi.reply(token, event.replyToken, lineApi.textMessage('這組代碼不存在，請確認是否輸入正確。'));
  }

  // ── 以下功能都需要已綁定 ──
  const user = lineUserId ? await bindings.findByLineUserId(lineUserId) : null;
  if (!user) {
    return lineApi.reply(token, event.replyToken, lineApi.textMessage(
      '您還沒有綁定帳號。\n\n請在 MedSafe 網頁的「LINE 提醒」中取得 8 碼綁定碼，再傳給我。'
    ));
  }

  // ── 家屬檢視身分：往下的每一條路徑（藥箱查詢、下次回診、自由文字 NLU）
  // 都是讀「這位使用者自己的」patient_data，家屬帳號沒有這份病歷——
  // 必須在這裡攔下，不能讓它們照舊制路徑跑到查無病歷或（更糟）誤判。
  // 見 CLAUDE.md：任何顯示病歷內容的路徑都必須走 LIFF + Custom Token，
  // 對第三方（家屬）比對病患本人更嚴格適用，Bot 文字回覆一律不碰。
  const role = await bindings.roleOf(user.uid);
  if (role === 'family') {
    return replyFamilyRedirect(token, event.replyToken);
  }

  // ── 選單 ──
  // 圖文教學卡（flex.tutorialCarousel()）取代純文字 HELP——內容與設計理由
  // 見 flex.js 該函式上方註解。quick reply 選單維持不變，圖卡按鈕與
  // quick reply 是同一組動作，看習慣哪個都能操作。
  if (MENU_RE.test(text)) {
    return lineApi.reply(token, event.replyToken,
      lineApi.withQuickReply(flex.tutorialCarousel(), menuItems()));
  }

  // ── 線上預約（見 BOOKING_RE／bookingReply 註解）──
  if (BOOKING_RE.test(text)) {
    return lineApi.reply(token, event.replyToken, bookingReply());
  }

  // ── 回報不適（見 SYMPTOM_RE／startSymptomReport 註解）──
  if (SYMPTOM_RE.test(text)) {
    return startSymptomReport(token, event, lineUserId);
  }

  // ── 藥箱查詢 ──
  //
  // 走 reply 而非 push，所以病患想查幾次都不計費（LINE 明文把 Reply API
  // 列為免費訊息）。把「隨時可查」設計成零成本，才能把付費的推播額度
  // 留給真正需要主動打斷對方的事——每日提醒與交互作用警示。
  if (CABINET_RE.test(text)) {
    return replyCabinet(token, event, user.username);
  }

  // ── 服藥時間表（見 replyTodaySchedule 註解）──
  if (SCHEDULE_RE.test(text)) {
    return replyTodaySchedule(token, event, user.username);
  }

  // ── 回報不適：接續上一步的等待狀態 ──
  //
  // 擺在所有固定指令分支之後、LLM 之前：先讓「藥箱」「時間表」這類明確
  // 指令照舊優先處理（按過回報不適後，若改口查藥箱，不該被誤轉成不適內容）；
  // 沒有更明確的意圖時，才視為上一步請他描述的那句話。10 分鐘逾時的旗標
  // 一律當作沒按過，正常落回下面的 NLU，不誤把不相關的閒聊轉給醫師。
  {
    const lu = await admin.firestore().collection('line_users').doc(lineUserId).get();
    const until = lu.exists && lu.data().awaitingSymptomUntil;
    if (typeof until === 'number' && until > Date.now()) {
      return forwardSymptomReport(token, event, user, lineUserId, text);
    }
  }

  // ── 自由文字（LLM 理解層）──
  //
  // 【擺在最後一個分支，而不是最前面】
  // 綁定碼與上面那幾條都是形狀明確、判斷零成本、且結果確定的路徑。
  // 讓它們先走完，LLM 只接手真正無法用規則判斷的句子——
  // 既省下每則訊息的 API 成本，也讓既有功能不因 LLM 故障而一起壞掉。
  return handleFreeText(token, event, user, text);
}

// 目前的用藥清單。關鍵字「藥箱」與 LLM 判定的 cabinet-query 都走這裡，
// 兩條路徑共用同一份回覆——分成兩份遲早會只改到其中一份。
async function replyCabinet(token, event, username, patientData) {
  let data = patientData;
  if (!data) {
    const snap = await admin.firestore().collection('patient_data').doc(username).get();
    if (!snap.exists) {
      return lineApi.reply(token, event.replyToken, lineApi.textMessage('查無您的用藥資料。'));
    }
    data = snap.data();
  }
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
    lines.push('・' + medName(m) + '　' + (m.dosage || '') + (m.hospital ? '（' + m.hospital + '）' : ''));
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
  return lineApi.reply(token, event.replyToken,
    lineApi.withQuickReply(lineApi.textMessage(lines.join('\n')), menuItems()));
}

// 服藥時間表：跟每日提醒卡（reminder.js 的排程推播）用同一份卡片版型，
// 但這裡是使用者自己按出來的，走 reply（免費），且刻意不去碰
// dailyLockKey 那把冪等鎖——那把鎖是用來擋「同一天重複推播」，查詢
// 跟排程推播是兩件事，搶同一把鎖只會讓當天 07:30 該送的提醒被跳過。
// 「查無病歷」與「有病歷但沒設提醒」分開回報，理由與 replyCabinet() 一致：
// 兩者對使用者的下一步不同，不可合併成同一句話。
async function replyTodaySchedule(token, event, username) {
  const snap = await admin.firestore().collection('patient_data').doc(username).get();
  if (!snap.exists) {
    return lineApi.reply(token, event.replyToken, lineApi.textMessage('查無您的用藥資料。'));
  }
  const data = snap.data();
  const reminders = Array.isArray(data.reminders) ? data.reminders : [];
  if (!reminders.length) {
    // 與 reminder.js 的 lineSendTestReminder 用同一句話，不要各自發明不同的說法
    return lineApi.reply(token, event.replyToken, lineApi.withQuickReply(
      lineApi.textMessage('尚未設定用藥提醒。請於 MedSafe 網頁的病患端設定每日提醒時段。'), menuItems()));
  }
  const name = (data.profile && data.profile.name) || username;
  const day = dayKey();
  const sorted = reminders.slice().sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return lineApi.reply(token, event.replyToken,
    lineApi.withQuickReply(flex.dailyReminderCard(name, day, sorted), menuItems()));
}

// 下次回診。掛號紀錄本身就是病患自己的資料，查詢條件也只有
// where(patient == 本人)——與藥箱查詢同一條路徑與同一個範圍。
async function replyNextVisit(token, event, username) {
  const snap = await admin.firestore().collection('appointments')
    .where('patient', '==', username).get();
  const active = snap.docs.map(d => d.data())
    .filter(a => a.status === 'booked' || a.status === 'arrived');
  if (!active.length) {
    return lineApi.reply(token, event.replyToken, lineApi.withQuickReply(
      lineApi.textMessage('您目前沒有預約中的回診。'), menuItems()));
  }
  // 沒有 dateKey 的是舊制掛號（只有日期、沒有診次與號碼），
  // 用 scheduledAt 補出日期字串，兩種形狀都要排得進來。
  // 舊制掛號沒有 dateKey，要從 Timestamp 反推日期字串。
  // 一律走 taipei-time 的 dayKey()——Functions 跑在 UTC，
  // 用 Node 的本地時區會把台北凌晨的掛號算成前一天（見該檔檔頭）。
  const keyOf = (a) => a.dateKey
    || (a.scheduledAt && a.scheduledAt.toDate ? dayKey(a.scheduledAt.toDate()) : '');
  active.sort((x, y) => String(keyOf(x)).localeCompare(String(keyOf(y))));
  const next = active[0];
  const lines = ['您的下次回診', ''];
  lines.push('・日期　' + (keyOf(next) || '（未指定）') + weekdaySuffix(keyOf(next)));
  if (next.session) lines.push('・診次　' + SESSION_LABEL[next.session] || next.session);
  if (next.doctorName || next.doctor) lines.push('・醫師　' + (next.doctorName || next.doctor));
  if (next.seq) {
    lines.push('・號碼　第 ' + next.seq + ' 號');
    lines.push('', '預估時間依前面的預約人數推算，實際請以現場叫號進度為準。');
  }
  if (active.length > 1) lines.push('', '（另有 ' + (active.length - 1) + ' 筆預約）');
  return lineApi.reply(token, event.replyToken,
    lineApi.withQuickReply(lineApi.textMessage(lines.join('\n')), menuItems()));
}

const SESSION_LABEL = { am: '早診', pm: '午診', night: '夜診' };
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
// 由 'YYYY-MM-DD' 算星期幾。逐項傳入建構子（而非 new Date(字串)）——
// new Date('2026-09-15') 會被當成 UTC 午夜解析，在 UTC+8 之外的執行環境
// 會退回前一天，星期就錯一格。
function weekdaySuffix(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key))) return '';
  const p = String(key).split('-').map(Number);
  return '（' + WEEKDAYS[new Date(p[0], p[1] - 1, p[2]).getDay()] + '）';
}

// 系統做不到的事。刻意寫成「我不能回答，但這些我可以」——
// 只說做不到會讓使用者無路可走，而在一個用藥系統裡，
// 讓模型去回答「這個藥能不能配葡萄柚」是拿臨床風險換一句漂亮的回覆。
// 這條線與 DDI 用規則引擎而非 LLM 是同一個立場：系統不做醫療判斷。
const OUT_OF_SCOPE = [
  '這個問題我無法回答。用藥相關的疑問，請直接詢問您的醫師或藥師，',
  '也可以在 MedSafe 網頁上留言給您的主治醫師。',
  '',
  '我可以幫您：',
  '・回報服藥，例如「早上的藥吃了」',
  '・查看目前的用藥（說「我在吃什麼藥」）',
  '・查詢下次回診',
  '・預約回診'
].join('\n');

// 按鈕流程的 fallback 訊息。NLU 失敗時一律退回這裡，
// 而不是回一句「我不懂」讓使用者無路可走。
const FALLBACK = '我不太確定您的意思。\n\n您可以按每日提醒卡上的時段按鈕回報，或輸入「藥箱」查看用藥。';

// 病歷裡的用藥記錄有兩種形狀並存：mockData.js 示範資料用 zhName/name，
// dashboard.html 醫師開立處方寫入的是 name_en/name_zh（見 patient.html
// medName() 的同一段說明）。這裡只認 zhName/name 會讓所有真實處方在
// LINE 對話裡都顯示成 undefined——沿用 DrugCatalog.medDisplayName() 的
// 目錄優先、雙欄位後備邏輯，才能兩種來源都顯示正確。
function medName(med) {
  const ddi = require('./ddi');
  return ddi.catalog().medDisplayName(med).zh;
}

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
    return lineApi.reply(token, event.replyToken,
      lineApi.withQuickReply(lineApi.textMessage(FALLBACK), menuItems()));
  }

  // 【意圖路由】不是服藥回報的句子，導到既有功能，而不是回一句「聽不懂」。
  //
  // 這些功能原本都只認完整錨定的關鍵字（CABINET_RE 等），
  // 說成「幫我看看藥箱裡有什麼」就落空——功能明明存在卻到不了。
  // 意圖分類與抽詞是同一次 LLM 呼叫的兩個欄位，因此這條路徑沒有額外成本。
  if (r.status === 'intent') {
    switch (r.intent) {
      case 'cabinet-query':
        return replyCabinet(token, event, user.username, patientData);
      case 'next-visit':
        return replyNextVisit(token, event, user.username);
      case 'booking':
        return lineApi.reply(token, event.replyToken, bookingReply());
      case 'help':
        return lineApi.reply(token, event.replyToken,
          lineApi.withQuickReply(lineApi.textMessage(HELP), menuItems()));
      case 'discomfort': {
        // 自由文字裡已經包含完整的敘述（例如「我頭很暈」），不必再走
        // 「按鈕→請描述→下一句」兩步——這裡的 text 本身就是要轉達的內容，
        // 與 SYMPTOM_RE／forwardSymptomReport() 是同一個轉達邏輯，
        // 只是省了中間那一步的往返。
        const lineUserId = event.source && event.source.userId;
        return forwardSymptomReport(token, event, user, lineUserId, text);
      }
      default:
        return lineApi.reply(token, event.replyToken,
          lineApi.withQuickReply(lineApi.textMessage(OUT_OF_SCOPE), menuItems()));
    }
  }

  if (r.status === 'no-extraction') {
    return lineApi.reply(token, event.replyToken,
      lineApi.withQuickReply(lineApi.textMessage(FALLBACK), menuItems()));
  }

  const day = dayKey();
  const lines = [];

  // ── 寫入高信心度的回報 ──
  for (const item of r.toRecord) {
    const res = await recordTaken(user.username, day, item.slot.time);
    const name = medName(item.med);
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
    const name = medName(n.med);
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
        const name = medName(med);
        const slot = (patientData.reminders || []).find(x => String(x.text || '').includes(name));
        if (!slot) continue;
        items.push({
          label: name,
          data: 'action=taken&day=' + day + '&time=' + encodeURIComponent(slot.time),
          displayText: name + ' 已服用'
        });
      }
    } else if (c.kind === 'pick-slot') {
      question = '「' + medName(c.med) + '」有多個時段，請問是哪一次？';
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
        label: c.slot.time + ' ' + medName(c.med),
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
    return lineApi.reply(token, event.replyToken,
      lineApi.withQuickReply(lineApi.textMessage(FALLBACK), menuItems()));
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

// 供 tests/line-webhook.test.mjs 驗證 LIFF_ID 有無設定時的選單／掛號回覆差異。
exports._internal = { menuItems, bookingReply, BOOKING_RE,
  CABINET_RE, SCHEDULE_RE, MENU_RE, SYMPTOM_RE, SYMPTOM_PREFIX, currentDoctorOf,
  OUT_OF_SCOPE, weekdaySuffix, SESSION_LABEL };

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
