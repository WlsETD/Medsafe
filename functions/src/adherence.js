// 服藥回報的伺服器端寫入。必須與 js/db-service.js 的 adherence 產生
// 完全相同形狀的資料——病患端網頁與 LINE 寫的是同一份 adherenceLog，
// 形狀對不上時，醫師看到的遵從率會是錯的，而且不會有任何錯誤訊息。

const admin = require('firebase-admin');
const { KEEP_DAYS } = require('./config');

const db = () => admin.firestore();

// 與 js/db-service.js 的 adherence.slotKey() 定義相同。
function slotKey(r) {
  return (r.time || '') + '|' + (r.text || '');
}

// 記錄「某個時段已服用」。
//
// 【為什麼不用 FieldValue.arrayUnion 直接往 adherenceLog.{day}.taken 追加】
// 一、日期字串含 '-'，用點路徑當欄位名要額外逸出，寫錯不會報錯只會寫到別處。
// 二、當天記錄如果還不存在（病患今天還沒開過網頁，直接在 LINE 上回報——
//     這正是預期中最常見的情況），arrayUnion 只會建出一個孤零零的 taken，
//     少了 total 與 schedule。db-service.js 的註解說得很清楚：每日記錄必須
//     自足，否則日後醫師調整排程，舊記錄就描述不出「那天原本該吃什麼」。
// 三、還要順便做 KEEP_DAYS 裁切。
// 因此走交易：讀出來、在記憶體裡組好完整的一天、整份寫回。
async function recordTaken(username, dayKey, time) {
  const ref = db().collection('patient_data').doc(username);

  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    // 查無病歷時據實回報，不可靜默假裝成功（本專案 P1-2 的一貫立場）
    if (!snap.exists) return { persisted: false, reason: 'no-record' };

    const data = snap.data();
    const reminders = Array.isArray(data.reminders) ? data.reminders : [];

    // postback 只帶 time，text 由伺服器從當下的 reminders 反查。
    // 這樣 postback data 可以維持很短（LINE 限制 300 bytes），
    // 也避免把可能很長的藥名字串在往返之間被截斷或改寫。
    const reminder = reminders.find(r => r.time === time);
    if (!reminder) return { persisted: false, reason: 'slot-gone' };

    const log = Object.assign({}, data.adherenceLog || {});
    const prev = log[dayKey];
    const taken = prev && Array.isArray(prev.taken) ? prev.taken.slice() : [];

    const key = slotKey(reminder);
    if (taken.some(t => slotKey(t) === key)) {
      // 已經回報過。這不是錯誤——長輩很可能會多按一次，
      // 或 LINE 因網路重試而送來兩次同樣的 postback。
      return { persisted: true, already: true, text: reminder.text };
    }

    // at 用 Date.now()（epoch 毫秒數字），與 patient.html 的 toggleReminder 相同。
    // 改用 Timestamp 會讓同一個陣列裡混進兩種型別，前端讀出來時無法一致處理。
    taken.push({ time: reminder.time, text: reminder.text, at: Date.now() });

    log[dayKey] = {
      // total 與 schedule 沿用當天既有的（若病患今天已在網頁上動過），
      // 否則以當下的排程建立。不可每次都覆寫成「現在的排程」——
      // 那會讓醫師今天下午改了藥之後，早上那筆記錄跟著變成新排程。
      total: prev && typeof prev.total === 'number' ? prev.total : reminders.length,
      schedule: prev && Array.isArray(prev.schedule)
        ? prev.schedule
        : reminders.map(r => ({ time: r.time, text: r.text })),
      taken
    };

    // 只保留最近 KEEP_DAYS 天（與 db-service.js 相同，理由見 config.js）
    const kept = {};
    for (const k of Object.keys(log).sort().reverse().slice(0, KEEP_DAYS)) kept[k] = log[k];

    tx.update(ref, { adherenceLog: kept });
    return { persisted: true, already: false, text: reminder.text };
  });
}

// 當天尚未回報的時段（每日提醒卡要標示哪些還沒吃）
function pendingSlots(patientData, dayKey) {
  const reminders = Array.isArray(patientData.reminders) ? patientData.reminders : [];
  const rec = (patientData.adherenceLog || {})[dayKey];
  const takenKeys = rec && Array.isArray(rec.taken) ? rec.taken.map(slotKey) : [];
  return reminders.filter(r => takenKeys.indexOf(slotKey(r)) === -1);
}

module.exports = { recordTaken, pendingSlots, slotKey };
