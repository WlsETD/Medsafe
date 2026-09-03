// 藥物交互作用偵測引擎（Phase 3）
//
// 本檔取代原本散落在 dashboard.html 中、以藥名字串比對的臨時邏輯。
// 修復的是三個層次的問題，其中第二個最嚴重：
//
//   一、比對方式：原本用 name_en 轉小寫後字串相等。跨院傳來的
//       「Warfarin Sodium」與本院的「Warfarin」比不到一起，交互作用直接漏判。
//       現改以 Phase 2 的 ATC 碼比對（js/drug-catalog.js）。
//
//   二、比對範圍：原本只比對「新開的藥 vs 現有藥」，從不檢查「現有藥彼此之間」。
//       示範病患 P004 目前同時服用 Warfarin、Aspirin、Amiodarone——
//       其中有兩組已知的重大交互作用，但除非醫師剛好要開第四種藥，
//       系統從頭到尾不會提起。病患已經身處風險中，畫面上卻一片平靜。
//
//   三、無從得知 vs 確認無虞：查不到規則不等於安全。成分不明的複方
//       （綜合維他命等）與系統不認得的藥，都必須明說「無法評估」，
//       不可併入「未發現交互作用」（稽核報告 P0-3、P1-12）。
//
// 本引擎不做臨床判斷，只做「知識庫裡有沒有記載」的查詢，並如實回報查詢的涵蓋範圍。

window.DdiEngine = (function () {

  // --- 嚴重度分級 ---
  // 用可排序的數值，讓多筆結果能依嚴重度排序、取最高者決定整體結論。
  // 字串比大小會得到字典序（'major' < 'minor'），是這類程式常見的錯誤來源。
  const SEVERITY = {
    contraindicated: { rank: 4, zh: '禁忌併用', cls: 'bg-red-100 text-danger border-red-200' },
    major:           { rank: 3, zh: '重大',     cls: 'bg-red-100 text-danger border-red-200' },
    moderate:        { rank: 2, zh: '中度',     cls: 'bg-orange-100 text-warning border-orange-200' },
    minor:           { rank: 1, zh: '輕微',     cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    // 【未分級自成一級，排在輕微之下】
    // 匯入 DDInter 時發現的問題：該資料庫有 4 萬餘筆交互作用的嚴重度標記為 Unknown。
    // 原本的做法是把它們當成 moderate 再加一個 severityUnknown 旗標——
    // 但畫面上斗大地寫著「中度」，旁邊一個小標籤寫「未分級」，
    // 醫師掃過去看到的就是「中度」。那是引擎替原始資料捏造了一個它沒說的分級。
    //
    // 更糟的是排序：moderate 的 rank 是 2，會壓過有明確記載的 minor（rank 1）。
    // 一筆「不知道多嚴重」的交互作用，排在一筆「已確認輕微」的前面——
    // 六筆這樣的項目塞進畫面，真正重大的那一筆就被稀釋掉了。這是警示疲勞的製造方式。
    unknown:         { rank: 0, zh: '未分級', cls: 'bg-slate-100 text-slate-600 border-slate-200' }
  };

  // 舊資料與雲端規則可能用中文嚴重度字串。一律正規化到上表的鍵，
  // 對不上的視為 moderate 並在結果中標記，而不是靜默丟棄整條規則——
  // 丟棄會讓一條真實存在的交互作用消失，比分級不準嚴重得多。
  const SEVERITY_ALIASES = {
    '禁忌': 'contraindicated', '禁忌併用': 'contraindicated', 'contraindicated': 'contraindicated',
    '極高風險': 'major', '重大': 'major', '高風險': 'major', 'major': 'major', 'high': 'major',
    '中度': 'moderate', '中風險': 'moderate', 'moderate': 'moderate', 'medium': 'moderate',
    '輕微': 'minor', '低風險': 'minor', 'minor': 'minor', 'low': 'minor'
  };

  function normalizeSeverity(raw) {
    const k = String(raw == null ? '' : raw).trim().toLowerCase();
    return SEVERITY_ALIASES[k] || SEVERITY_ALIASES[String(raw || '').trim()] || null;
  }

  // ATC 是階層碼：V08A 是「含碘顯影劑」這個類別，V08AB02 是其下的碘海醇。
  // 一條寫在 V08A 上的規則，必須能命中未來加入目錄的任何一個具體顯影劑成分，
  // 否則每新增一個廠牌就要重寫規則，而漏寫的那一個就是下一次漏判。
  //
  // 只允許「規則較廣、藥物較specific」的方向匹配：規則 V08A 命中藥物 V08AB02，
  // 但規則 V08AB02 不命中藥物 V08A——後者代表「我們只知道是顯影劑，不知是哪一種」，
  // 套用特定成分的規則屬於超出已知範圍的推論。
  function atcMatches(ruleAtc, drugAtc) {
    if (!ruleAtc || !drugAtc) return false;
    const r = String(ruleAtc).toUpperCase(), d = String(drugAtc).toUpperCase();
    return d === r || d.startsWith(r);
  }

  // 把任意來源的一筆用藥（可能只有藥名、可能已帶 atc）解析為統一結構。
  // 解析不到時 atc 為 null 並保留原始字串，供 UI 誠實地說「不認得這個」。
  function toEntry(med) {
    const C = window.DrugCatalog;
    const rawName = (med && (med.name_en || med.name || med.zhName || med.name_zh)) || '';
    // 資料自帶的 atc 優先，但仍需經目錄確認存在；查不到就退回以藥名解析。
    let drug = null;
    if (med && med.atc && C) drug = C.byAtc(med.atc);
    if (!drug && C) drug = C.resolve(rawName);
    return {
      raw: String(rawName || ''),
      atc: drug ? drug.atc : null,
      name_en: drug ? drug.name_en : String(rawName || ''),
      name_zh: drug ? drug.name_zh : '',
      known: !!drug,
      // 成分不明的複方：查無規則時不得判定為安全（P1-12）
      clearable: drug ? window.DrugCatalog.canBeClearedAsSafe(drug.atc) : false,
      unclearableReason: C ? C.unclearableReason(drug ? drug.atc : rawName) : ''
    };
  }

  return {
    SEVERITY: SEVERITY,
    normalizeSeverity: normalizeSeverity,
    atcMatches: atcMatches,

    // 【本機規則庫的唯一組裝點】
    //
    // 修復前，這段 concat 在四個地方各寫一次（醫師端病患清單、交互作用檢測、
    // 關係圖、病患端藥箱），測試檔裡還有第五份。DDInter 匯入後問題就浮現了：
    // 規則檔已經產生並進了版控，但那四個地方沒有一個載入它——
    // 236 條規則只在管理後台被拿來顯示統計數字，實際比對從未用到。
    //
    // 這正是稽核報告 P0-7 記下的那個教訓的另一種形式：
    // 「測試通過不等於使用者看到的是對的」。這裡是「資料匯入了不等於引擎用得到」。
    // 收斂成單一入口之後，測試與畫面必然吃到同一份規則，不可能再各自漂移。
    //
    // 【合併順序有臨床意義，不可調換】
    // 人工維護的規則排在前面。normalizeRules 去重時「取先到者」，因此同一組藥
    // 若兩邊都有收錄，保留的是帶有作用機轉、處置建議與 ACR 出處的那一條，
    // 而不是 DDInter 只有嚴重度的版本。Warfarin × Aspirin 就是實例：
    // 反過來合併會讓醫師從「應避免併用，必須併用時監測 INR 與出血徵兆」
    // 退化成一個沒有下文的「major」。
    localRuleSet() {
      const M = window.mockData || {};
      const D = window.DDINTER_RULES;
      const curated = (M.ddiRules || []).concat((M.graphData || {}).links || []);
      // 出處在合併時才掛上，不寫進產生檔——產生檔應該是原始資料的忠實副本，
      // 「這批資料是誰給的」屬於引用它的程式該負責交代的事。
      const imported = (D && Array.isArray(D.rules))
        ? D.rules.map(function (r) {
            return Object.assign({}, r, {
              source: D.source,
              reviewedOn: D.importedOn,
              // 只有嚴重度、沒有機轉與處置建議。UI 必須據實說明，
              // 不可留白讓醫師以為系統對這組藥沒有話說。
              detailLevel: D.detailLevel || 'severity-only'
            });
          })
        : [];
      return curated.concat(imported);
    },

    // 規則正規化。雲端與本地規則的欄位命名不一致（graphData.links 用 source/target，
    // ddi_rules 用 drugA/drugB），在此收斂為單一形狀，讓比對邏輯只需認識一種規則。
    //
    // 兩端都解析不到 ATC 的規則會被丟棄並回報——一條比對不到任何藥的規則
    // 只會讓 ruleCount 虛胖，讓醫師以為知識庫比實際更完整。
    normalizeRules(rawRules) {
      const C = window.DrugCatalog;
      const out = [];
      const dropped = [];
      const seen = new Set();
      for (const r of (rawRules || [])) {
        if (!r) continue;
        const aName = r.drugA || r.source || '';
        const bName = r.drugB || r.target || '';
        const aDrug = (r.atcA || r.atcSource) ? (C && C.byAtc(r.atcA || r.atcSource)) : null;
        const bDrug = (r.atcB || r.atcTarget) ? (C && C.byAtc(r.atcB || r.atcTarget)) : null;
        // 規則可能寫在目錄尚未收錄的類別碼上（例如未來的 V03AB），
        // 那時 byAtc 查不到但碼本身仍可用於階層比對，故保留原字串。
        const atcA = (aDrug && aDrug.atc) || r.atcA || r.atcSource || (C && C.resolve(aName) ? C.resolve(aName).atc : null);
        const atcB = (bDrug && bDrug.atc) || r.atcB || r.atcTarget || (C && C.resolve(bName) ? C.resolve(bName).atc : null);
        if (!atcA || !atcB) {
          dropped.push({ a: aName, b: bName, why: '兩端至少一方無法解析為 ATC 碼' });
          continue;
        }
        const key = [String(atcA).toUpperCase(), String(atcB).toUpperCase()].sort().join('|');
        if (seen.has(key)) continue;   // 本地與雲端重複收錄同一組，取先到者
        seen.add(key);
        const sev = normalizeSeverity(r.severity);
        out.push({
          atcA: String(atcA).toUpperCase(),
          atcB: String(atcB).toUpperCase(),
          severity: sev || 'unknown',
          // 分級對不上時明確標記，讓 UI 可以說明「此規則的嚴重度未分級」，
          // 而不是讓醫師以為系統判定它是中度
          severityUnknown: !sev,
          effect: r.effect || r.description || '',
          recommendation: r.recommendation || '',
          // 出處與複核日期。metformin × 顯影劑那條規則的內容已隨 ACR 指引改版而過時
          //（詳見 js/mockData.js 的說明），證明臨床規則會變、且變了不會有人通知你。
          // 沒有出處的規則無法複核，等同於無法維護。
          source: r.source || null,
          reviewedOn: r.reviewedOn || null,
          // 'severity-only' 代表這條規則只有嚴重度分級，沒有作用機轉與處置建議
          //（DDInter 匯入的規則皆是如此，原始 CSV 只提供 Drug_A/Drug_B/Level）。
          // 少了這個旗標，UI 只會看到 effect 與 recommendation 都是空字串，
          // 於是畫面上出現一則沒有任何說明的警示——醫師無從判斷那是
          // 「系統沒查到細節」還是「這組藥本來就沒什麼好說的」。
          detailLevel: r.detailLevel || 'full'
        });
      }
      return { rules: out, dropped: dropped };
    },

    // 【引擎主體】
    //
    // meds：本次要一併評估的所有用藥（現有用藥 + 本次新開立的藥，呼叫端自行合併）。
    //       每筆可以是 {atc}、{name_en}、{name} 或三者兼有。
    // rawRules：本地與雲端規則的聯集，未正規化亦可。
    //
    // 回傳的結構刻意把「查到的交互作用」與「無法評估的藥」分成兩個欄位。
    // 這是本引擎最重要的設計：兩者混在一起就會退化成原本那個
    // 「非紅即綠」的二元結論，而醫療系統真正需要的第三種答案是「我不知道」。
    analyze(meds, rawRules) {
      const entries = (meds || []).map(toEntry);
      const norm = this.normalizeRules(rawRules);
      const rules = norm.rules;

      const findings = [];
      const seenPair = new Set();

      // 比對「所有兩兩組合」，而非只比新開的藥。
      // 現有用藥彼此之間的交互作用同樣會傷害病患，且往往已持續存在一段時間。
      let pairsChecked = 0;
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const A = entries[i], B = entries[j];
          if (!A.atc || !B.atc) continue;     // 不認得的藥另循 unevaluable 回報
          pairsChecked++;
          for (const rule of rules) {
            const hit = (atcMatches(rule.atcA, A.atc) && atcMatches(rule.atcB, B.atc))
                     || (atcMatches(rule.atcB, A.atc) && atcMatches(rule.atcA, B.atc));
            if (!hit) continue;
            const k = [A.atc, B.atc].sort().join('|') + '#' + rule.atcA + '|' + rule.atcB;
            if (seenPair.has(k)) continue;
            seenPair.add(k);
            findings.push({
              a: A, b: B,
              severity: rule.severity,
              severityRank: SEVERITY[rule.severity].rank,
              severityZh: SEVERITY[rule.severity].zh,
              severityClass: SEVERITY[rule.severity].cls,
              severityUnknown: rule.severityUnknown,
              effect: rule.effect,
              recommendation: rule.recommendation,
              source: rule.source,
              reviewedOn: rule.reviewedOn,
              detailLevel: rule.detailLevel
            });
          }
        }
      }
      findings.sort((x, y) => y.severityRank - x.severityRank);

      // 【分級與未分級分開回報：警示疲勞的控制點】
      //
      // DDInter 匯入的規則中有一半以上（116/224）的嚴重度是原始資料庫自己標的
      // 「Unknown」。把它們與 Warfarin × Aspirin 以同樣的重量呈現，實測的後果是：
      // 示範病患 P001–P003 從「未發現」全部翻成 risk，病患端首頁會寫
      // 「您的用藥中有 11 組已知交互作用」，其中 6 組是未分級的。
      //
      // 稽核報告 P1-13 對這件事的判斷很明確：「一個『過度警示』的系統不是
      // 『比較安全』的系統——它會訓練醫師忽略所有警示，連真正重要的那一則
      // 也一起被忽略。」把未分級的塞進主要警示區，等於用 6 則不知道多嚴重的
      // 記載去稀釋那 1 則真正需要停下來看的。
      //
      // 但也不能把它們丟掉：DDInter 確實記載了這些組合，丟掉等於對醫師宣稱
      // 「這些交互作用不存在」。因此改為分層——分級的決定結論，未分級的
      // 另列一區據實呈現。
      const graded = findings.filter(f => !f.severityUnknown);
      const ungraded = findings.filter(f => f.severityUnknown);

      // 無法評估的藥分兩類，理由不同，對醫師的意義也不同：
      //   unknown-drug：系統不認得這個藥名，可能是拼寫、可能是目錄未收錄
      //   composition：認得，但它是配方不定的複方，本質上無法據碼判斷成分
      const unevaluable = [];
      for (const e of entries) {
        if (!e.known) {
          unevaluable.push({ entry: e, kind: 'unknown-drug', reason: e.unclearableReason });
        } else if (!e.clearable) {
          unevaluable.push({ entry: e, kind: 'composition', reason: e.unclearableReason });
        }
      }

      // 整體結論。順序即優先順序：有查到交互作用最優先，
      // 其次是「有藥無法評估」，最後才是「查無已知交互作用」。
      //
      // 注意 no-known-interaction 這個名稱：它說的是知識庫沒有記載，
      // 不是臨床上安全。UI 的措辭必須守住這個區別（P0-3）。
      // 【verdict 只有三種值，不可自行擴充】
      // firestore.rules 第 288 行強制 safetyCheck.verdict 必須是
      // ['risk', 'unevaluable', 'no-known-interaction'] 其中之一。
      // 多加一種「找到了但未分級」的第四種值，處方會直接被規則擋下寫不進去。
      //
      // 因此只有未分級結果時歸入 unevaluable，而不是 no-known-interaction——
      // 知識庫明明查到了東西，說「未發現已知交互作用」是不實陳述，
      // 而那正是稽核報告 P0-3 反覆在講的那個錯誤形狀。
      let verdict;
      if (graded.length > 0) verdict = 'risk';
      else if (unevaluable.length > 0 || ungraded.length > 0) verdict = 'unevaluable';
      else verdict = 'no-known-interaction';

      return {
        verdict: verdict,
        // findings 只含已分級者。呼叫端沿用既有欄位名即可得到「該停下來看的那幾則」，
        // 不必逐一改寫判斷條件——漏改的地方會是未分級混入主要警示區的破口。
        findings: graded,
        ungraded: ungraded,
        unevaluable: unevaluable,
        entries: entries,
        pairsChecked: pairsChecked,
        ruleCount: rules.length,
        droppedRules: norm.dropped,
        // 最高嚴重度只由已分級者決定。未分級的不得觸發 Phase 4 的處方攔截：
        // 攔截是強制性的臨床流程約束，不能建立在一個「不知道多嚴重」的記載上。
        topSeverity: graded.length ? graded[0].severity : null
      };
    }
  };
})();

// Node 測試環境下同時掛到 module.exports，讓測試不必模擬瀏覽器
if (typeof module !== 'undefined' && module.exports) module.exports = window.DdiEngine;
