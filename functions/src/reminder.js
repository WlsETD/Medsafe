// 每日用藥彙整卡（排程推播）。
//
// 每天台北時間 07:30 推一張卡給所有已綁定且有提醒設定的病患，卡上每個時段
// 一個回報按鈕。這是唯一的例行 push，成本 30 則/人/月（決策見 linebot.md §7）。

const admin = require('firebase-admin');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');

const { LINE_CHANNEL_ACCESS_TOKEN, REGION, TZ } = require('./config');
const lineApi = require('./line-api');
const bindings = require('./bindings');
const flex = require('./flex');
const { dayKey } = require('./taipei-time');
const { claimPushSlot, releasePushSlot } = require('./push-lock');

// 供 webhook.js 判斷「今天已經推過每日卡了嗎」使用同一把鎖的 key 組法。
// 綁定成功當下若立即送出當日卡片，就該佔用這把鎖——否則 07:30 排程會
// 認為今天還沒推過，重複再送一次幾乎一樣的卡片。
function dailyLockKey(username, day) {
  return username + '__' + day + '__daily';
}

async function runDailyReminder() {
  const token = LINE_CHANNEL_ACCESS_TOKEN.value();
  const day = dayKey();
  const active = await bindings.listActiveBindings();

  let sent = 0, skipped = 0, failed = 0, quotaHit = false;

  for (const b of active) {
    try {
      const snap = await admin.firestore().collection('patient_data').doc(b.username).get();
      if (!snap.exists) { skipped++; continue; }

      const data = snap.data();
      const reminders = Array.isArray(data.reminders) ? data.reminders : [];
      if (!reminders.length) { skipped++; continue; }

      const key = dailyLockKey(b.username, day);
      if (!await claimPushSlot(key)) { skipped++; continue; }

      const name = (data.profile && data.profile.name) || b.username;
      const sorted = reminders.slice().sort((x, y) => String(x.time).localeCompare(String(y.time)));
      const card = flex.dailyReminderCard(name, day, sorted);

      const r = await lineApi.push(token, b.lineUserId, card);
      if (r.ok) {
        sent++;
      } else {
        failed++;
        if (r.quotaExceeded) quotaHit = true;
        // 推播失敗時把鎖放掉，讓下一次觸發還有機會補送。
        // 留著鎖等於「失敗一次就整天不再嘗試」。
        await releasePushSlot(key);
        logger.error('推播失敗', { username: b.username, status: r.status, body: r.body });
      }
    } catch (e) {
      failed++;
      logger.error('每日提醒處理失敗', { username: b.username, error: e.message });
    }
  }

  // 額度用完必須留下明確的紀錄。病患沒收到提醒，而系統以為一切正常，
  // 是這個功能最危險的失效模式——「沒收到提醒」不可以被理解成「今天不用吃藥」。
  if (quotaHit) {
    logger.error('LINE 訊息額度可能已用盡（收到 429），本日部分提醒未送達');
  }
  logger.info('每日提醒完成', { day, total: active.length, sent, skipped, failed });
  return { day, sent, skipped, failed };
}

exports.dailyReminderPush = onSchedule(
  {
    region: REGION,
    // 台北時間每天 07:30。timeZone 已指定，這裡寫的就是當地時間，
    // 不需要（也不可以）自己換算成 UTC。
    schedule: '30 7 * * *',
    timeZone: TZ,
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
    retryCount: 1
  },
  async () => { await runDailyReminder(); }
);

// 展示與測試用：手動觸發一次今日提醒（只推給呼叫者本人）。
// 錄影時比等排程可靠得多，也不必把系統時間改來改去。
const { onCall, HttpsError } = require('firebase-functions/v2/https');

exports.lineSendTestReminder = onCall(
  { region: REGION, secrets: [LINE_CHANNEL_ACCESS_TOKEN] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', '請先登入');
    const roleSnap = await admin.firestore().collection('user_roles').doc(request.auth.uid).get();
    if (!roleSnap.exists || roleSnap.data().status !== 'active') {
      throw new HttpsError('permission-denied', '帳號未啟用');
    }
    const username = roleSnap.data().username;

    const binding = await bindings.getBinding(username);
    if (!binding || !binding.active) {
      throw new HttpsError('failed-precondition', '尚未綁定 LINE');
    }

    const snap = await admin.firestore().collection('patient_data').doc(username).get();
    if (!snap.exists) throw new HttpsError('not-found', '查無病歷');
    const data = snap.data();
    const reminders = Array.isArray(data.reminders) ? data.reminders : [];
    if (!reminders.length) throw new HttpsError('failed-precondition', '尚未設定用藥提醒');

    const day = dayKey();
    const name = (data.profile && data.profile.name) || username;
    const sorted = reminders.slice().sort((x, y) => String(x.time).localeCompare(String(y.time)));

    // 測試推播刻意不佔用每日冪等鎖：否則按了測試按鈕之後，
    // 當天早上真正的排程提醒就會被跳過。
    const r = await lineApi.push(
      LINE_CHANNEL_ACCESS_TOKEN.value(),
      binding.lineUserId,
      flex.dailyReminderCard(name, day, sorted)
    );
    if (!r.ok) {
      throw new HttpsError('internal', r.quotaExceeded ? 'LINE 訊息額度已用盡' : '推播失敗');
    }
    return { ok: true, slots: sorted.length };
  }
);

exports.dailyLockKey = dailyLockKey;
exports._runDailyReminder = runDailyReminder;
