// 推播冪等鎖，供每日提醒、交互作用警示、（現在）綁定成功時的即時卡片共用。
//
// 【為什麼抽成共用模組】
// reminder.js 與 prescription.js 原本各自寫了一份幾乎相同的 create()-as-lock
// 邏輯。這裡再加入第三處使用者（webhook.js 綁定成功時），若繼續各寫一份，
// 遲早會有一處漏改（例如只有兩處記得「失敗時要放鎖」），變成本專案一貫警惕的
// 「同一件事在多處手動維護，遲早不同步」的形狀（見 firestore.rules 的展示帳號
// 白名單註解）。

const admin = require('firebase-admin');

// 用 create() 而非「先讀再寫」：文件已存在時 create() 直接失敗，
// 這個失敗本身就是鎖，由 Firestore 保證原子性，不受同時觸發的多個執行個體影響。
async function claimPushSlot(key) {
  try {
    await admin.firestore().collection('line_push_log').doc(key).create({
      at: admin.firestore.FieldValue.serverTimestamp()
    });
    return true;
  } catch (e) {
    if (e.code === 6 || /already exists/i.test(e.message || '')) return false;
    throw e;
  }
}

// 推播失敗時呼叫，讓下一次觸發還有機會補送。
// 留著鎖等於「失敗一次就永久不再嘗試」，那是比重複推播更糟的失效模式。
async function releasePushSlot(key) {
  await admin.firestore().collection('line_push_log').doc(key).delete().catch(() => {});
}

module.exports = { claimPushSlot, releasePushSlot };
