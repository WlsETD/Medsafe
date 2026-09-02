// 藥物身分的單一權威來源（Phase 2　藥物身分基礎建設）。
//
// 【這個檔案要解決什麼問題】
// 在此之前，系統中存在四套互不相容的藥物身分：
//   1. patients[].medications[].id —— 每位病患各自的陣列流水號。
//      id=1 在 P001 是 Metformin，在 P004 卻是 Warfarin；
//      而 Metformin 在 P001 是 1、在 P004 是 4。同一個號碼指不同藥、同一種藥有不同號碼。
//   2. allMedications[].id —— 另一套獨立流水號（Metformin 在此是 3）。
//   3. graphData.nodes[].id —— 英文藥名字串。
//   4. ddi_rules 的 drugA/drugB —— 英文藥名字串。
//
// 交互作用比對因此只能退而求其次，用藥名小寫完全比對。這在跨院情境下必然失效：
// A 醫院寫 "Warfarin"、B 醫院寫 "warfarin sodium"、C 醫院寫「可邁丁」，
// 比對引擎看到的是三個不相干的字串。
//
// 這才是「跨院用藥衝突預警」能否成立的地基——規則庫無論是 2 條還是 30 萬條，
// 只要藥物身分沒有統一，跨院比對就無法成立。
//
// 【身分基準：WHO ATC 碼】
// 本檔所有 ATC 碼皆已於 2026-09-02 逐一對照 WHO Collaborating Centre 官方資料庫
// （https://atcddd.fhi.no/atc_ddd_index/ ，原 whocc.no 已 301 轉址至此）確認，
// 非依記憶填寫。DDD 值一併記錄，供日後劑量合理性檢核使用。
//
// 【已知限制，必須誠實看待】
// 一、ATC 是「解剖—治療—化學」分類，不是全球唯一的藥品識別碼。同一成分會因適應症
//     而有不同 ATC 碼——本系統的 aspirin 即為實例：抗血小板用途為 B01AC06，
//     止痛退燒用途為 N02BA01。若只認單一碼，A 院用 B01AC06、B 院用 N02BA01 時，
//     跨院比對會誤判為兩種不同的藥，那正是本檔要消滅的問題。
//     因此每種藥物可宣告 atcAliases，解析時一律歸戶到同一個藥物身分。
// 二、下方的 aliases（商品名、中文名）是示範用的種子資料，涵蓋範圍有限。
//     正式上線必須改以衛福部「藥品許可證資料集」建立完整的
//     台灣上市藥品中文商品名 ↔ 成分 ↔ ATC 對照表。
// 三、承上，resolve() 查不到時回傳 null，呼叫端「絕對不可」把 null 當成
//     「沒有交互作用」。那是 P0-3 記載的 fail-open，是本專案最危險的一類錯誤。
//     null 的意思是「本系統不認得這個藥」，必須據實呈現給使用者。

window.DrugCatalog = (function () {

  // 目前系統涵蓋的 6 種藥物。ATC 碼即為其在全系統中的唯一身分。
  const DRUGS = [
    {
      atc: 'B01AA03', name_en: 'Warfarin', name_zh: '華法林',
      class_zh: '抗凝血劑', ddd: '7.5 mg (O)',
      atcAliases: [],
      aliases: ['warfarin sodium', 'coumadin', '可邁丁', '華法令']
    },
    {
      atc: 'B01AC06', name_en: 'Aspirin', name_zh: '阿斯匹靈',
      class_zh: '抗血小板劑', ddd: '1 tablet (O)',
      // 同成分、不同適應症的另一組 ATC 碼。跨院資料可能以任一碼傳來，
      // 兩者都必須解析到同一個藥物身分，否則交互作用會被漏判。
      atcAliases: ['N02BA01'],
      // 中文譯名的四種組合都要收：台灣慣用「阿斯匹靈」、大陸慣用「阿司匹林」，
      // 而混用的「阿斯匹林」「阿司匹靈」在實際病歷與跨院資料中都出現得到。
      // 這類變體無法靠演算法推導，只能逐一收錄——也正因如此，
      // 手工別名表必然有缺口，resolve() 查不到時回傳 null 而非猜測才是安全的預設。
      aliases: ['acetylsalicylic acid', 'asa', 'aspirin', '乙醯柳酸',
                '阿司匹林', '阿斯匹林', '阿司匹靈']
    },
    {
      atc: 'C01BD01', name_en: 'Amiodarone', name_zh: '胺碘酮',
      class_zh: '抗心律不整劑', ddd: '0.2 g (O)',
      atcAliases: [],
      aliases: ['amiodarone hydrochloride', 'cordarone', '安碘酮']
    },
    {
      atc: 'A10BA02', name_en: 'Metformin', name_zh: '二甲雙胍',
      class_zh: '降血糖藥', ddd: '2 g (O)',
      atcAliases: [],
      aliases: ['metformin hydrochloride', 'glucophage', '滅糖尿', '甲福明']
    },
    {
      atc: 'C09AA03', name_en: 'Lisinopril', name_zh: '賴諾普利',
      class_zh: '降血壓藥（ACE 抑制劑）', ddd: '10 mg (O)',
      atcAliases: [],
      aliases: ['zestril', 'prinivil', '理欣諾普利']
    },
    {
      atc: 'C10AA05', name_en: 'Atorvastatin', name_zh: '阿托伐他汀',
      class_zh: '降血脂藥（statin）', ddd: '20 mg (O)',
      atcAliases: [],
      aliases: ['atorvastatin calcium', 'lipitor', '立普妥', '阿托伐司他汀']
    },

    // 類別層級的身分。並非所有臨床上重要的交互作用都發生在「兩個特定成分」之間——
    // Metformin 與含碘顯影劑併用可能誘發乳酸中毒（可致命，檢查前須停藥），
    // 而該作用來自整個顯影劑類別，不是其中某一個成分。
    //
    // ATC 本身就支援類別層級的碼，V08A 即為官方定義的
    // 「X-RAY CONTRAST MEDIA, IODINATED」（已於 2026-09-02 對照 WHO 官方確認），
    // 其下再分 V08AA/V08AB/V08AC/V08AD 四個子群。
    //
    // 以 kind: 'group' 明確標示，是為了不讓後續程式把它誤當成一個具體成分——
    // 例如劑量檢核、重複用藥偵測就不該套用在類別碼上。
    {
      atc: 'V08A', kind: 'group',
      name_en: 'Iodinated contrast media', name_zh: '含碘顯影劑',
      class_zh: 'X 光顯影劑（含碘）', ddd: null,
      atcAliases: [],
      aliases: ['iodinated', 'iodinated contrast', 'iodinated contrast media',
                'contrast media', '顯影劑', '含碘顯影劑', '碘造影劑']
    },

    {
      atc: 'A11CC05', name_en: 'Vitamin D3', name_zh: '維生素 D3',
      class_zh: '營養補充（維生素 D）', ddd: '20 mcg (800 IU) (O)',
      atcAliases: [],
      aliases: ['colecalciferol', 'cholecalciferol', 'vitamin d3', 'vit d3',
                'vitamin d', '膽鈣化醇', '維他命 D3', '維生素d3']
    },

    // 【成分不明的複方——本目錄中最危險的一類】
    //
    // 「綜合維他命」不是一種成分，而是一個配方會因產品而異的複方。A11A 這個碼
    // 只說明「這是綜合維他命」，完全不說明「裡面有什麼」。
    //
    // 這在本系統中是一個真實存在的風險，而不是理論上的：示範病患王大明同時服用
    // Warfarin 與綜合維他命。多數綜合維他命含維生素 K，而維生素 K 正是 warfarin 的
    // 直接拮抗劑——會削弱抗凝效果、提高血栓風險。但交互作用引擎去查
    // 「A11A × B01AA03」時會查無規則，若因此回報「未發現交互作用」，
    // 就是在一個可能致命的真實組合上 fail-open。
    //
    // 因此標記 compositionVaries: true。凡帶此旗標的藥物，交互作用引擎
    // 「不得」將其判定為安全或無交互作用，只能回報「成分不明，無法排除交互作用，
    // 請向藥師確認實際配方」。這條規則必須在 Phase 3 的引擎中強制執行。
    {
      atc: 'A11A', kind: 'group', compositionVaries: true,
      name_en: 'Multivitamin', name_zh: '綜合維他命',
      class_zh: '營養補充（複方，配方因產品而異）', ddd: null,
      atcAliases: [],
      aliases: ['multivitamin', 'multivitamins', 'multi vitamin',
                '綜合維他命', '綜合維生素', '多種維他命']
    }
  ];

  // 鹽類與劑型後綴。跨院傳來的藥名常帶這些字尾，但它們不改變成分身分：
  // "Warfarin" 與 "Warfarin Sodium" 是同一種藥。
  const SALT_SUFFIXES = [
    'sodium', 'potassium', 'calcium', 'magnesium', 'hydrochloride', 'hcl',
    'sulfate', 'sulphate', 'succinate', 'maleate', 'tartrate', 'besylate',
    'mesylate', 'fumarate', 'acetate', 'citrate', 'phosphate'
  ];

  // 劑型與劑量詞。"Metformin 500mg 錠" 與 "Metformin" 也是同一種藥。
  const FORM_WORDS = [
    'tablet', 'tablets', 'tab', 'tabs', 'capsule', 'capsules', 'cap', 'caps',
    'injection', 'inj', 'oral', 'film', 'coated', 'extended', 'release', 'er', 'sr', 'xr',
    '錠', '膜衣錠', '膠囊', '注射劑', '口服', '緩釋'
  ];

  // 把任意來源的藥名字串壓成可比對的鍵：
  // 去掉括號內容、劑量數字、鹽類與劑型詞，轉小寫並收斂空白。
  function normalize(raw) {
    let s = String(raw == null ? '' : raw).toLowerCase();
    s = s.replace(/\([^)]*\)/g, ' ');               // 去括號內容
    s = s.replace(/[0-9]+(\.[0-9]+)?\s*(mg|g|mcg|ug|ml|iu|%)\b/g, ' '); // 去劑量
    s = s.replace(/[^a-z0-9一-鿿]+/g, ' '); // 只留英數與中日韓統一漢字
    const drop = new Set(SALT_SUFFIXES.concat(FORM_WORDS));
    s = s.split(' ').filter(w => w && !drop.has(w)).join(' ');
    return s.trim();
  }

  // 建索引：每種藥的 ATC 碼、別名 ATC 碼、學名、中文名與所有別名都指向同一個藥物物件。
  const byKey = new Map();
  const byAtcCode = new Map();
  function index(key, drug) {
    const k = normalize(key);
    if (!k) return;
    // 同一個鍵被兩種不同的藥宣告，代表種子資料本身有衝突，
    // 那會讓比對結果取決於陣列順序——寧可在載入時就吵起來，也不要靜默取其一。
    const existing = byKey.get(k);
    if (existing && existing.atc !== drug.atc) {
      throw new Error('[DrugCatalog] 別名衝突：「' + key + '」同時被 ' + existing.atc + ' 與 ' + drug.atc + ' 宣告');
    }
    byKey.set(k, drug);
  }
  for (const d of DRUGS) {
    // 未標示者一律視為單一成分、成分明確，讓呼叫端可以無條件信賴這兩個欄位存在
    if (!d.kind) d.kind = 'substance';
    if (d.compositionVaries === undefined) d.compositionVaries = false;
    byAtcCode.set(d.atc, d);
    for (const a of d.atcAliases) byAtcCode.set(a, d);
    index(d.atc, d);
    for (const a of d.atcAliases) index(a, d);
    index(d.name_en, d);
    index(d.name_zh, d);
    for (const a of d.aliases) index(a, d);
  }

  return {
    // 全部藥物，供後台清單與下拉選單使用
    all() { return DRUGS.slice(); },

    // 以 ATC 碼取藥（含 atcAliases，因此 N02BA01 也取得到 aspirin）
    byAtc(atc) { return byAtcCode.get(String(atc || '').toUpperCase()) || null; },

    // 【本檔的核心】把任意藥名字串解析為藥物身分。
    // 學名、鹽類形式、國際商品名、中文名、含劑量與劑型的字串皆可。
    //
    // 查不到時回傳 null，而不是猜一個最接近的。醫療系統寧可說「不認得」，
    // 也不可以把「猜的」當成「確認的」——那是 P0-3 那類錯誤的另一種形式。
    resolve(rawName) {
      const k = normalize(rawName);
      if (!k) return null;
      return byKey.get(k) || null;
    },

    // 兩個藥名是否為同一種成分。跨院比對的基本問句：
    // sameDrug('warfarin sodium', '可邁丁') === true
    sameDrug(nameA, nameB) {
      const a = this.resolve(nameA);
      const b = this.resolve(nameB);
      return !!(a && b && a.atc === b.atc);
    },

    // ATC 前 5 碼為「治療子群」。同子群不同成分（例如兩種 statin）即為重複用藥，
    // 是跨院最常見的實際危害之一。供後續階段的重複用藥偵測使用。
    //
    // 類別層級的碼（kind === 'group'，如 V08A）本身就已經是一個群，
    // 再取前 5 碼沒有意義，直接回傳原碼。重複用藥偵測也不該套用於類別碼——
    // 「病患同時用了兩種顯影劑」與「病患同時用了兩種 statin」不是同一回事。
    subgroup(atc) {
      const d = this.byAtc(atc);
      if (!d) return null;
      return d.kind === 'group' ? d.atc : d.atc.slice(0, 5);
    },

    // 是否為單一成分（而非類別碼）。劑量檢核、重複用藥偵測等只適用於成分。
    isSubstance(atc) {
      const d = this.byAtc(atc);
      return !!d && d.kind === 'substance';
    },

    // 【Phase 3 的交互作用引擎必須呼叫這個函式】
    // 回答的是：「查無交互作用規則時，能不能把這個藥判定為安全？」
    //
    // 對成分不明的複方，答案永遠是不能。綜合維他命常含維生素 K，
    // 而維生素 K 是 warfarin 的直接拮抗劑；但 A11A 這個碼不記載配方，
    // 因此「查無規則」在這裡的真正含意是「無從得知」，不是「確認無虞」。
    // 把前者呈現為後者，就是 P0-3 那個 fail-open 換了一個位置重演。
    canBeClearedAsSafe(atc) {
      const d = this.byAtc(atc);
      if (!d) return false;              // 不認得的藥，同樣不可判定為安全
      return !d.compositionVaries;
    },

    // 無法判定為安全時，要對使用者說明的理由。UI 直接顯示這句，
    // 不要自行拼裝——措辭本身就是安全設計的一部分。
    unclearableReason(atc) {
      const d = this.byAtc(atc);
      if (!d) return '本系統不認得此藥品，無法進行交互作用比對，請向藥師確認。';
      if (d.compositionVaries) {
        return d.name_zh + ' 為複方製劑，實際成分因產品而異（可能含維生素 K 等會影響其他藥物的成分），'
             + '本系統無法據此排除交互作用，請攜帶實際產品向藥師確認。';
      }
      return '';
    },

    // 顯示用名稱。UI 一律經由此函式取名，避免各頁面各自拼字串。
    displayName(atc) {
      const d = this.byAtc(atc);
      return d ? d.name_en + '（' + d.name_zh + '）' : String(atc || '未知藥物');
    }
  };
})();
