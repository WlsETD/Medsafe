// 把 LLM 抽出的藥物描述，對應回「病患自己的用藥」與「病患自己的提醒時段」。
//
// 【為什麼候選集是病患自己的藥，而不是整本藥典】
// DrugCatalog.resolve() 是正規化後的精確查表，查不到就回 null 不猜（見該檔註解）。
// 但長輩不會說「賴諾普利」，會說「血壓藥」「白色那顆」——那是類別或外觀，
// 不是藥名，查整本藥典必然落空。改成只在病患自己的 3~5 筆用藥裡找，
// 候選集小到「唯一解」的判定才可靠。
//
// 【這個設計順帶解決了「LLM 不得生成 ATC 碼」】
// ATC 一律取自病患既有病歷裡的那筆 medication，LLM 的輸出只被當成待比對的字串。
// 就算它幻覺出一個 NOATC-* 或編一組 ATC，也不會有任何一筆病歷欄位被它污染——
// 這比在 system prompt 裡叮嚀它不要生成要硬得多。

const logger = require('firebase-functions/logger');
const ddi = require('./ddi');

// 目錄載入失敗只記一次，不讓每則訊息都刷一行同樣的錯誤
let warnedCatalog = false;

// 信心度分層。數字本身不精確，重點是「哪一層的證據比較強」的排序：
// 目錄命中 > 類別命中 > 名稱子字串。低於 nlu.js 的 MIN_CONFIDENCE_AUTO 者
// 一律要使用者確認，不直接寫入病歷。
const CONF_CATALOG = 0.95;
const CONF_CATEGORY = 0.85;
const CONF_SUBSTRING = 0.7;

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().trim();
}

// 這筆 medication 的所有可顯示名稱（用來比對 reminder.text 與使用者說法）
function medNames(med) {
  return [med.zhName, med.name, med.name_zh, med.name_en].filter(Boolean);
}

// 把單一描述字串比對到病患的用藥。回傳 0、1 或多筆。
function matchOne(description, meds) {
  const q = norm(description);
  if (!q) return [];

  // ── 第一層：藥物目錄（含商品名、中文名、鹽類與劑型變體）──
  // resolve() 認得的是真正的藥名，命中即為最強證據。
  let catalogHit = null;
  try {
    catalogHit = ddi.catalog().resolve(description);
  } catch (e) {
    // 目錄載入失敗不讓整個比對崩掉——還有類別與名稱兩層可用，
    // 而少了目錄只會讓命中「變少」（更多描述落到 unmatched 去追問），
    // 不會讓它「猜錯」，方向上是安全的。
    //
    // 但這仍是不該發生的事，必須留下記錄：靜默降級的藥名比對，
    // 症狀是「商品名突然都認不得了」，而 log 裡什麼都沒有。
    if (!warnedCatalog) {
      warnedCatalog = true;
      logger.error('藥物目錄載入失敗，藥名比對已降級為類別與子字串', { error: e.message });
    }
    catalogHit = null;
  }
  if (catalogHit) {
    const byAtc = meds.filter(m => m.atc === catalogHit.atc);
    if (byAtc.length) return byAtc.map(med => ({ med, confidence: CONF_CATALOG }));
  }

  // ── 第二層：藥品類別 ──
  // 「血壓藥」對上類別「降血壓藥」。雙向 includes：使用者可能說得比
  // 欄位短（血壓藥 ⊂ 降血壓藥），也可能說得比欄位長（降血壓的藥 ⊃ 降血壓藥）。
  //
  // 【類別優先查目錄，m.category 只是後備】
  // dashboard.html 醫師開立處方寫入的病歷（name_en/name_zh 形狀）從不帶
  // category 欄位——那是 mockData.js 示範資料才有的欄位。若只讀 m.category，
  // 這一層對所有真實處方永遠是空的，等於「血壓藥」「降血糖藥」這種長輩
  // 最常見的說法對真實病患完全失效，只有示範帳號測得出來。
  // 目錄裡每個藥都有 class_zh（例如「降血壓藥（ACE 抑制劑）」），用 ATC
  // 反查即可涵蓋真實處方；m.category 留著只為了不影響既有示範資料路徑。
  const byCategory = meds.filter(m => {
    const catalogEntry = m.atc ? ddi.catalog().byAtc(m.atc) : null;
    const c = norm((catalogEntry && catalogEntry.class_zh) || m.category);
    return c && (c.includes(q) || q.includes(c));
  });
  if (byCategory.length) return byCategory.map(med => ({ med, confidence: CONF_CATEGORY }));

  // ── 第三層：名稱子字串 ──
  // 錯字與簡稱的最後一道網（「阿托伐」對上「阿托伐他汀」）。
  const bySubstring = meds.filter(m =>
    medNames(m).some(n => {
      const v = norm(n);
      return v && (v.includes(q) || q.includes(v));
    })
  );
  if (bySubstring.length) return bySubstring.map(med => ({ med, confidence: CONF_SUBSTRING }));

  return [];
}

// 【對外】把 LLM 抽出的每一項描述比對到病患用藥。
//
// 回傳三種互斥的結果：
//   matched   —— 唯一命中，可以往下走
//   candidates—— 命中多筆，需要使用者從候選清單挑（quick reply）
//   unmatched —— 完全沒命中，據實說「不認得」，不猜最接近的那個
function matchMedications(extractedItems, patientMedications) {
  const meds = Array.isArray(patientMedications) ? patientMedications : [];
  const matched = [];
  const candidates = [];
  const unmatched = [];

  for (const item of extractedItems || []) {
    const hits = matchOne(item.name, meds);
    if (hits.length === 1) {
      matched.push({ extracted: item, med: hits[0].med, confidence: hits[0].confidence });
    } else if (hits.length > 1) {
      candidates.push({ extracted: item, options: hits });
    } else {
      unmatched.push(item.name);
    }
  }

  return { matched, candidates, unmatched };
}

// 【對外】把「哪一種藥」翻譯成「哪一個提醒時段」。
//
// 【為什麼一定要多這一層】
// adherenceLog 的最小單位是 reminder slot（去重鍵是 time|text，見 adherence.js），
// 不是藥。recordTaken() 只收 time，因此自由文字最後一定要落到某個 slot，
// 落不到就不能寫。
//
// 【一個時段含多種藥時的取捨】
// reminders[].text 可能是「服用賴諾普利、阿托伐他汀」——一個時段兩種藥。
// 使用者說「血壓藥吃了，降血脂藥忘了」時，slot 無法被拆開：勾了就是整段勾。
// 此時回 partial，由上層改問「這個時段的藥都吃了嗎」，不擅自代為判定。
function resolveReminderSlots(matchedItems, patientReminders) {
  const reminders = Array.isArray(patientReminders) ? patientReminders : [];
  const resolved = [];
  const ambiguous = [];
  const noSlot = [];

  for (const m of matchedItems || []) {
    const names = medNames(m.med).map(norm).filter(Boolean);
    const slots = reminders.filter(r => {
      const t = norm(r.text);
      return t && names.some(n => t.includes(n));
    });

    if (slots.length === 1) {
      resolved.push({ slot: slots[0], med: m.med, extracted: m.extracted, confidence: m.confidence });
    } else if (slots.length > 1) {
      // 同一種藥出現在多個時段（例如一天兩次的 Metformin）。使用者若沒說
      // 是哪一餐，系統不可以替他選一個——勾錯時段在遵從率上是一筆假資料。
      ambiguous.push({ med: m.med, extracted: m.extracted, slots });
    } else {
      // 藥在病歷裡，但沒有任何提醒時段提到它（醫師開了藥但沒設提醒）。
      // 這不是錯誤，但也無處可寫。
      noSlot.push({ med: m.med, extracted: m.extracted });
    }
  }

  return { resolved, ambiguous, noSlot };
}

module.exports = {
  matchMedications,
  resolveReminderSlots,
  matchOne,
  CONF_CATALOG,
  CONF_CATEGORY,
  CONF_SUBSTRING
};
