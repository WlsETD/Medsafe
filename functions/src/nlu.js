// 自由文字服藥回報的決策層：抽詞 → 比對 → 決定「寫入 / 追問 / 據實說不認得」。
//
// 【這一層不碰 Firestore，也不碰 LINE】
// 它只回傳一個描述「該做什麼」的結果物件，由 webhook.js 去執行。
// 這樣整條判斷邏輯可以在測試裡不接資料庫、不接 LINE、不打 LLM 就跑完。

const llm = require('./llm');
const medMatch = require('./med-match');

// 低於此信心度一律改用 quick reply 讓使用者確認，不直接寫入病歷。
//
// 【為什麼門檻放在 0.8】
// med-match.js 的三層證據分別是 0.95（藥物目錄命中）、0.85（藥品類別命中）、
// 0.7（名稱子字串）。0.8 這條線的實際意義是：目錄與類別命中可以直接記，
// 「只是字面上有點像」一律要問過。病歷寫錯無法刪除（本專案的病歷設計），
// 因此這條線寧可偏保守——多問一句的成本，遠低於一筆假的遵從率資料。
const MIN_CONFIDENCE_AUTO = 0.8;

// 有效信心度取兩者較低者：LLM 對「我有沒有讀懂這句話」的信心，
// 與比對層對「這個描述是不是就是這顆藥」的信心，任一薄弱都不該直接寫入。
function effectiveConfidence(llmConfidence, matchConfidence) {
  const a = typeof llmConfidence === 'number' ? llmConfidence : 1;
  return Math.min(a, matchConfidence);
}

// 【對外】處理一句自由文字。
//
// 回傳：
//   { status: 'intent', intent }                    不是服藥回報，由 webhook 路由
//   { status: 'no-extraction' }                     是服藥回報但句子裡沒提到任何藥
//   { status: 'error', error }                      LLM 或比對過程出錯
//   { status: 'ok', toRecord, confirm, notRecorded, unmatched }
//
//   toRecord    可以直接寫入的（唯一命中、信心度足夠、且使用者說的是「吃了」）
//   confirm     需要 quick reply 追問的（多筆候選、多個時段、信心度不足）
//   notRecorded 使用者說「沒吃／不確定」的——刻意不寫入，只回覆確認（見下）
//   unmatched   完全不認得的描述，據實回報，不猜最接近的那個
//
// 【為什麼「沒吃」不寫入 Firestore】
// adherenceLog 目前只有 taken 陣列，「沒有被列進 taken」就是未服用——
// 沒有「明確未服用」這個狀態。要為此新增 skipped 欄位，會動到 patient.html
// 的遵從率計算與醫師端顯示，超出這支功能的範圍；而病歷不可刪除，寫錯無法補救。
// 因此這裡只回覆「這個時段還沒回報」，把資料模型的擴充留到有需要時再談。
async function processUserInput(text, patientData) {
  const meds = (patientData && patientData.medications) || [];
  const reminders = (patientData && patientData.reminders) || [];

  let understanding;
  try {
    understanding = await llm.understandMessage(text, meds);
  } catch (e) {
    return { status: 'error', error: e.message };
  }

  // 不是服藥回報就到此為止，把意圖交還給 webhook 去路由。
  // 這一層刻意不知道「藥箱查詢」「預約」要怎麼回覆——那是執行層的事，
  // 與本檔開頭「這一層不碰 Firestore、也不碰 LINE」是同一個分工。
  if (understanding.intent !== 'adherence-report') {
    return { status: 'intent', intent: understanding.intent };
  }

  const extracted = understanding.items;
  if (!Array.isArray(extracted) || extracted.length === 0) {
    return { status: 'no-extraction' };
  }

  const { matched, candidates, unmatched } = medMatch.matchMedications(extracted, meds);
  const { resolved, ambiguous, noSlot } = medMatch.resolveReminderSlots(matched, reminders);

  const toRecord = [];
  const confirm = [];
  const notRecorded = [];

  for (const r of resolved) {
    const conf = effectiveConfidence(r.extracted.confidence, r.confidence);
    const action = r.extracted.action;

    if (action !== 'taken') {
      // 「沒吃」與「不確定」都只回覆，不寫入（理由見函式註解）
      notRecorded.push({ med: r.med, slot: r.slot, action });
      continue;
    }
    if (conf < MIN_CONFIDENCE_AUTO) {
      confirm.push({ kind: 'low-confidence', med: r.med, slot: r.slot, confidence: conf });
      continue;
    }
    toRecord.push({ slot: r.slot, med: r.med, confidence: conf });
  }

  // 一個描述對到多顆藥 —— 讓使用者從候選清單挑，不替他選
  for (const c of candidates) {
    confirm.push({ kind: 'pick-drug', said: c.extracted.name, options: c.options.map(o => o.med) });
  }

  // 一顆藥橫跨多個時段 —— 讓使用者指定是哪一餐
  for (const a of ambiguous) {
    confirm.push({ kind: 'pick-slot', med: a.med, slots: a.slots });
  }

  // 藥在病歷裡但沒有對應的提醒時段，無處可寫
  for (const n of noSlot) {
    notRecorded.push({ med: n.med, slot: null, action: n.extracted.action, reason: 'no-slot' });
  }

  return { status: 'ok', toRecord, confirm, notRecorded, unmatched };
}

module.exports = { processUserInput, effectiveConfidence, MIN_CONFIDENCE_AUTO };
