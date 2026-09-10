// 新處方的跨院交互作用即時警示。
//
// 這是整個 LINE 整合裡唯一「別家做不到」的功能：單一醫院的官方帳號結構上
// 不可能知道病患在別家醫院拿了什麼藥。醫師在 A 院開藥的那一刻，病患的手機
// 就收到「這與您在 B 院的某某藥有重大交互作用」——把系統的核心主張變成
// 一件在長輩手機上真的會發生的事。

const admin = require('firebase-admin');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');

const { LINE_CHANNEL_ACCESS_TOKEN, REGION } = require('./config');
const lineApi = require('./line-api');
const bindings = require('./bindings');
const flex = require('./flex');
const ddi = require('./ddi');
const { claimPushSlot: claimOnce, releasePushSlot } = require('./push-lock');

// 一組藥對只警示一次。
//
// 沒有這道去重，任何一次對 patient_data 的更新（改個提醒、回報一次吃藥）
// 都會重新觸發，於是同一則警示會反覆推播——不但燒光訊息額度，
// 更會直接訓練長輩忽略這個官方帳號的所有訊息。
function pairKey(username, f) {
  const a = (f.a && f.a.atc) || '?';
  const b = (f.b && f.b.atc) || '?';
  return username + '__ddi__' + [a, b].sort().join('_');
}

exports.onPrescriptionAdded = onDocumentUpdated(
  {
    document: 'patient_data/{username}',
    region: REGION,
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
    // 引擎與規則庫約 355 KB，載入需要記憶體與時間
    memory: '512MiB',
    timeoutSeconds: 60
  },
  async (event) => {
    const username = event.params.username;
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};

    const oldMeds = Array.isArray(before.medications) ? before.medications : [];
    const newMeds = Array.isArray(after.medications) ? after.medications : [];

    // 只在用藥清單真的變長時才動作。回報吃藥、改提醒都會更新這份文件，
    // 但那些都不該觸發警示。
    if (newMeds.length <= oldMeds.length) return;

    const binding = await bindings.getBinding(username);
    if (!binding || !binding.active || !binding.lineUserId) return;

    // 新增的藥（addMedicationToPatient 一律 push 到末尾）
    const added = newMeds.slice(oldMeds.length);

    // 對「合併後的完整清單」跑分析，而不是只比新藥與舊藥——
    // 引擎本來就是設計成比對所有兩兩組合，沿用它的結論即可。
    const result = ddi.analyze(newMeds);
    const worthy = ddi.pushWorthyFindings(result);
    if (!worthy.length) return;

    // 只推「與這次新增的藥有關」的那幾則。清單裡原本就存在的交互作用
    // 不該在開了一個無關的藥時突然跳出來——那會讓警示與事件對不上，
    // 病患無從判斷發生了什麼事。
    const addedAtc = new Set(added.map(m => m.atc).filter(Boolean));
    const addedNames = new Set(added.map(m => (m.name || '').toLowerCase()).filter(Boolean));
    const related = worthy.filter(f => {
      const ids = [f.a, f.b].filter(Boolean);
      return ids.some(x =>
        (x.atc && addedAtc.has(x.atc)) ||
        (x.name && addedNames.has(String(x.name).toLowerCase()))
      );
    });
    if (!related.length) return;

    // 逐對去重，只留下沒推播過的
    const fresh = [];
    for (const f of related) {
      if (await claimOnce(pairKey(username, f))) fresh.push(f);
    }
    if (!fresh.length) return;

    const newMedName = added.map(m => m.zhName || m.name).filter(Boolean).join('、') || '新增的藥';
    // decorate 把中文藥名與「來自哪一家醫院」接回訊息——跨院這件事
    // 正是這則警示唯一的說服力來源（見 ddi.js 的 describe()）
    const card = flex.ddiAlertCard(newMedName, ddi.decorate(fresh, newMeds));

    const r = await lineApi.push(LINE_CHANNEL_ACCESS_TOKEN.value(), binding.lineUserId, card);
    if (r.ok) {
      logger.info('已推播交互作用警示', { username, count: fresh.length });
    } else {
      logger.error('交互作用警示推播失敗', {
        username, status: r.status, quotaExceeded: r.quotaExceeded, body: r.body
      });
      // 推播失敗時把去重鎖放掉，讓下一次還有機會補送。
      // 這是唯一一則「漏掉會有臨床後果」的訊息，不可以因為一次網路錯誤就永久消失。
      for (const f of fresh) {
        await releasePushSlot(pairKey(username, f));
      }
    }
  }
);
