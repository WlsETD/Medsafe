// 醫師在留言板回覆時，推播一則通知到病患的 LINE（純文字，不含完整病歷內容）。
//
// 這是本專案第一個由「病患-醫師對話」觸發的推播，補上 LINE 整合原本只有
// 「藥」（每日卡、DDI 警示）沒有「話」的缺口——回報不適（webhook.js 的
// SYMPTOM_RE／forwardSymptomReport()）把病患的話寫進 conversations，
// 這裡把醫師的回覆送回去，一來一回才算完整的迴路。
//
// 【為什麼可以推播訊息內容，而不算違反「顯示病歷要走 LIFF」的原則】
// CLAUDE.md 那條原則管的是「把整份病歷讀出來顯示」——這裡只轉發*這一則*
// 醫師剛剛主動、明確寫給這位病患的訊息本身，範圍與 DDI 警示卡（同樣會把
// 藥名、嚴重度等病歷衍生內容放進推播文字）是同一個量級，不是撈整份紀錄
// 出來顯示。且訊息本來就是醫師打算讓這位病患看到的內容，不是第三方視角。
//
// 【為什麼是 push 而非 reply】醫師的動作發生在網頁端，此時沒有一個
// 「病患剛傳來的訊息」可以 reply——這是主動通知，必然計費（見
// CLAUDE.md「Reply vs push 是成本決策」）。

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');

const { LINE_CHANNEL_ACCESS_TOKEN, REGION, LIFF_ID } = require('./config');
const lineApi = require('./line-api');
const bindings = require('./bindings');
const { claimPushSlot, releasePushSlot } = require('./push-lock');

function clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

exports.onDoctorMessageAdded = onDocumentCreated(
  {
    document: 'conversations/{patient}/messages/{mid}',
    region: REGION,
    secrets: [LINE_CHANNEL_ACCESS_TOKEN]
  },
  async (event) => {
    const { patient, mid } = event.params;
    const msg = event.data && event.data.data();
    // 病患自己送出的訊息（含 SYMPTOM_PREFIX 那種由 webhook.js 代寫的）
    // 不需要、也不該推播給自己。只有 from === 'doctor' 才是這支要處理的方向。
    if (!msg || msg.from !== 'doctor') return;

    const binding = await bindings.getBinding(patient);
    if (!binding || !binding.active || !binding.lineUserId) return;

    // 以訊息文件 ID 當鎖——它本來就是 Firestore 自動產生的全域唯一 ID，
    // 觸發器的 at-least-once 語意（同一事件可能重試）不會因此重複推播，
    // 與 push-lock.js 既有的 create()-as-lock 是同一套機制。
    const lockKey = 'chatmsg:' + mid;
    if (!await claimPushSlot(lockKey)) return;

    const liffId = LIFF_ID.value();
    const url = liffId ? 'https://liff.line.me/' + liffId + '?view=chat' : null;
    const body = '您的醫師回覆了留言板：\n\n' + clip(msg.text, 300)
      + (url ? '' : '\n\n請至 MedSafe 網頁的留言板查看並回覆。');
    // LIFF_ID 未設定時不給一個開不了的死連結，只用純文字提示——
    // 與 bookingReply()／menuItems() 對 LIFF_ID 未設定時的處理是同一個原則。
    const message = url
      ? lineApi.withQuickReply(lineApi.textMessage(body), [{ label: '開啟留言板', uri: url }])
      : lineApi.textMessage(body);

    const r = await lineApi.push(LINE_CHANNEL_ACCESS_TOKEN.value(), binding.lineUserId, message);
    if (r.ok) {
      logger.info('已推播醫師留言通知', { patient });
    } else {
      logger.error('醫師留言通知推播失敗', {
        patient, status: r.status, quotaExceeded: r.quotaExceeded, body: r.body
      });
      // 推播失敗時放掉鎖，讓下一次觸發（若有）還有機會補送；
      // 與 reminder.js／prescription.js 既有的失敗處理一致。
      await releasePushSlot(lockKey);
    }
  }
);
