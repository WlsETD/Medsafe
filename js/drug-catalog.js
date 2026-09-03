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
    // 這個風險在本系統中可被實際觸發：綜合維他命已收錄於藥品主檔，醫師可直接開立，
    // 而 P004 正在服用 Warfarin。維生素 K 是 warfarin 的拮抗劑——市售綜合維他命的
    // 維生素 K1 含量通常低於足以影響抗凝的劑量，但已有病例報告顯示穩定服用 warfarin 的
    // 病患在開始服用綜合維他命後 INR 下降。臨床共識是「攝取量維持穩定並監測 INR」，
    // 不是「禁止併用」——分寸講錯同樣會造成傷害（病患自行停用或恐慌）。
    //
    // 真正的問題在於 A11A 這個碼「不記載配方」：系統無從得知某一盒綜合維他命
    // 含不含維生素 K、含多少。因此引擎查不到規則時，正確的回應是「無從得知」，
    // 不是「未發現交互作用」。
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
    },

    // ── 2026-09-02 擴充：Firestore 規則庫中出現、但目錄原本認不得的 17 種藥 ──
    //
    // 起因是一個實測結果：雲端 ddi_rules 有 21 條去重後的規則，
    // 引擎卻只用得到 4 條——其餘 17 條因為兩端的藥名無法解析為 ATC 碼而被丟棄。
    // 被丟棄的包括 Digoxin × Amiodarone（洋地黃中毒）、Aspirin × Clopidogrel
    //（雙重抗血小板）、Rivaroxaban × Aspirin（大出血）等臨床上很重要的組合。
    //
    // 也就是說：規則庫的內容是好的，但因為目錄太小，醫師端一條都不會觸發。
    // 這比規則本身寫錯更難察覺——畫面上不會有任何跡象。
    //
    // 【ATC 碼的查證方式】其中四個已直接向 WHO ATC/DDD Index 逐一比對：
    //   C03CA01 furosemide（DDD 40 mg）、B01AC04 clopidogrel、
    //   B01AC06 acetylsalicylic acid、A12AA04 calcium carbonate（DDD 3 g）。
    // 其餘為長期確立的常見藥物編碼。正式上線前應全數再對照官方索引一次，
    // 因此每筆均標註 verifiedOn，日後可據此判斷哪些已複核、哪些尚未。

    { atc: 'N06AB03', name_en: 'Fluoxetine', name_zh: '氟西汀',
      class_zh: '抗憂鬱劑（SSRI）', ddd: '20 mg (O)', verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['prozac', '百憂解', '氟苯氧丙胺'] },

    { atc: 'N06DA02', name_en: 'Donepezil', name_zh: '多奈哌齊',
      class_zh: '失智症用藥（膽鹼酯酶抑制劑）', ddd: '7.5 mg (O)', verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['aricept', '愛憶欣', '多奈哌齊鹽酸鹽'] },

    { atc: 'N05BA06', name_en: 'Lorazepam', name_zh: '勞拉西泮',
      class_zh: '抗焦慮劑（苯二氮平類）', ddd: '2.5 mg (O)', verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['ativan', '安定文', '樂耐平'] },

    { atc: 'C01AA05', name_en: 'Digoxin', name_zh: '地高辛',
      class_zh: '強心配醣體', ddd: '0.25 mg (O)', verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['lanoxin', '毛地黃', '狄高辛'] },

    // 已向 WHO ATC/DDD Index 直接查證
    { atc: 'C03CA01', name_en: 'Furosemide', name_zh: '呋塞米',
      class_zh: '利尿劑（亨利氏環）', ddd: '40 mg (O)', verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['lasix', '來適泄', '呋喃苯胺酸', 'frusemide'] },

    { atc: 'M04AC01', name_en: 'Colchicine', name_zh: '秋水仙素',
      class_zh: '痛風用藥', ddd: null, verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['colchicum', '秋水仙鹼'] },

    { atc: 'B01AF01', name_en: 'Rivaroxaban', name_zh: '利伐沙班',
      class_zh: '抗凝血劑（直接 Xa 因子抑制劑）', ddd: '20 mg (O)', verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['xarelto', '拜瑞妥'] },

    // 已向 WHO ATC/DDD Index 直接查證
    { atc: 'B01AC04', name_en: 'Clopidogrel', name_zh: '氯吡格雷',
      class_zh: '抗血小板劑', ddd: '75 mg (O)', verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['plavix', '保栓通', '氯吡多'] },

    // 【2026-09-03 更正】原本把「瑪爾胰」列為本藥別名，那是錯的：
    // 瑪爾胰是 Amaryl 的中文商品名，成分為 glimepiride（A10BB12），不是 glipizide。
    // 已依衛福部藥品許可證「衛署藥輸字第022671號」查證（Sanofi，2 mg 錠）。
    //
    // 這個錯誤是在本次擴充目錄、加入 glimepiride 時被 index() 的別名衝突守衛
    // 擋下來才發現的——兩種藥同時宣告同一個商品名，載入就直接拋錯。
    // 若沒有那道守衛，結果會是「取決於陣列順序的靜默誤判」：
    // 處方寫「瑪爾胰」會被解析成 glipizide，此後交互作用比對一律套用錯的那一種藥。
    // 兩者同為磺醯脲類，危害有限，但它是不折不扣的藥物身分誤判——
    // 而藥物身分正是 P1-10 要消滅的那一類問題。
    { atc: 'A10BB07', name_en: 'Glipizide', name_zh: '格列吡嗪',
      class_zh: '降血糖藥（磺醯尿素類）', ddd: '10 mg (O)', verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['minidiab', '格力匹來'] },

    { atc: 'C07AB02', name_en: 'Metoprolol', name_zh: '美托洛爾',
      class_zh: '乙型阻斷劑', ddd: '150 mg (O)', verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['betaloc', 'lopressor', '舒壓寧', '美托普洛'] },

    { atc: 'C09CA03', name_en: 'Valsartan', name_zh: '纈沙坦',
      class_zh: '降血壓藥（ARB）', ddd: '80 mg (O)', verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['diovan', '得安穩'] },

    { atc: 'A02BC01', name_en: 'Omeprazole', name_zh: '奧美拉唑',
      class_zh: '氫離子幫浦阻斷劑', ddd: '20 mg (O)', verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['losec', 'prilosec', '樂酸克', '奧米拉唑'] },

    { atc: 'C03DA01', name_en: 'Spironolactone', name_zh: '螺內酯',
      class_zh: '保鉀利尿劑（醛固酮拮抗劑）', ddd: '75 mg (O)', verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['aldactone', '安達通', '螺旋內酯'] },

    { atc: 'M01AE01', name_en: 'Ibuprofen', name_zh: '布洛芬',
      class_zh: '非類固醇消炎止痛藥（NSAID）', ddd: '1.2 g (O)', verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['brufen', 'advil', '依普芬', '異丁苯丙酸'] },

    { atc: 'H03AA01', name_en: 'Levothyroxine', name_zh: '左旋甲狀腺素',
      class_zh: '甲狀腺荷爾蒙', ddd: '150 mcg (O)', verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['eltroxin', 'synthroid', '昂特欣', '甲狀腺素', 'levothyroxine sodium'] },

    // 已向 WHO ATC/DDD Index 直接查證。
    // A02AC01 是「制酸劑用途」的碳酸鈣，A12AA04 是「鈣補充劑用途」——
    // 與 aspirin 的 B01AC06／N02BA01 同一種情況：同成分因適應症而有兩個碼，
    // 兩者都必須歸戶到同一個藥物身分，否則跨院比對會把它們當成兩種不同的藥。
    { atc: 'A12AA04', name_en: 'Calcium carbonate', name_zh: '碳酸鈣',
      class_zh: '鈣補充劑／制酸劑', ddd: '3 g (O)', verifiedOn: '2026-09-02',
      atcAliases: ['A02AC01'], aliases: ['calcium carbonate', '鈣片', '碳酸鈣錠', 'caco3'] },

    { atc: 'M05BA04', name_en: 'Alendronate', name_zh: '阿侖膦酸鈉',
      class_zh: '骨質疏鬆用藥（雙磷酸鹽）', ddd: '10 mg (O)', verifiedOn: '2026-09-02',
      atcAliases: [], aliases: ['fosamax', '福善美', 'alendronic acid', '阿侖磷酸鹽'] },

    // ──────────────────────────────────────────────────────────────────
    // 【2026-09-03　目錄擴充：34 種】
    //
    // 擴充的依據不是「哪些藥常見」，而是實際算出來的：
    // tools/import-ddinter.mjs 的報告顯示，DDInter 去重後有 234,981 組交互作用，
    // 而本目錄只認得其中 236 組（0.10%）。涵蓋率低不是因為 DDInter 資料不足，
    // 是因為目錄太小——兩端都要認得規則才成立，所以涵蓋率大約是收錄比例的平方。
    //
    // 本批 34 種是按「加入後可立即啟用幾條規則」排序挑出來的，
    // 且多為 CYP450 的強誘導劑或抑制劑（rifampicin、carbamazepine、phenytoin、
    // clarithromycin、erythromycin、ciprofloxacin、verapamil、diltiazem、
    // cimetidine、ciclosporin），這正是交互作用最密集的一群。
    //
    // 修復前缺了它們的實際後果：Warfarin × Clarithromycin、Warfarin × Ciprofloxacin
    // 這類重大交互作用，系統不是「規則沒收錄」，而是「不認得那個藥」而完全靜默。
    //
    // 【ATC 碼與 DDD 的查證方式】
    // 本批 34 筆全數於 2026-09-03 逐一對照 WHO Collaborating Centre 官方索引
    // （https://atcddd.fhi.no/atc_ddd_index/）以群組頁面確認，非依記憶填寫，
    // 因此 verifiedOn 一律為 2026-09-03。
    //
    // 【別名必須含 DDInter 的拼法，否則等於沒加】
    // 匯入工具是拿 DDInter CSV 裡的藥名去 resolve()。有兩個名字對不上就會整批漏掉：
    //   ·「Glyburide」是美國藥典名，WHO 的 INN 是 glibenclamide（A10BB01）
    //   ·「Cyclosporine」是美國藥典名，WHO 的 INN 是 ciclosporin（L04AD01）
    // 兩者都已收進 aliases。這類拼法差異無法靠演算法推導，漏一個就是靜默漏判。
    // ──────────────────────────────────────────────────────────────────

    // --- 消化道與代謝 ---
    { atc: 'A02BA01', name_en: 'Cimetidine', name_zh: '西咪替丁',
      class_zh: '制酸劑（H2 受體拮抗劑）', ddd: '0.8 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['tagamet', '泰胃美', '希每得定', '甲氰咪胍'] },

    { atc: 'A02BA02', name_en: 'Ranitidine', name_zh: '雷尼替丁',
      class_zh: '制酸劑（H2 受體拮抗劑）', ddd: '0.3 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['zantac', '善胃得', '雷尼替定'] },

    { atc: 'A02BA03', name_en: 'Famotidine', name_zh: '法莫替丁',
      class_zh: '制酸劑（H2 受體拮抗劑）', ddd: '40 mg (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['pepcid', '蓋舒泰', '法莫替定'] },

    // 【DDInter 寫作 Glyburide】美國藥典名與 WHO 的 INN 不同，兩者都必須收。
    { atc: 'A10BB01', name_en: 'Glibenclamide', name_zh: '格列本脲',
      class_zh: '口服降血糖藥（磺醯脲類）', ddd: '10 mg (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['glyburide', 'daonil', 'euglucon', '優降糖', '格利本脲'] },

    { atc: 'A10BB12', name_en: 'Glimepiride', name_zh: '格列美脲',
      class_zh: '口服降血糖藥（磺醯脲類）', ddd: '2 mg (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['amaryl', '瑪爾胰', '格美脲'] },

    // --- 心血管 ---
    { atc: 'C01BA01', name_en: 'Quinidine', name_zh: '奎尼丁',
      class_zh: '抗心律不整藥（Class Ia）', ddd: '1.2 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['quinidine sulfate', '奎尼丁硫酸鹽', '奎尼定'] },

    { atc: 'C07AG02', name_en: 'Carvedilol', name_zh: '卡維地洛',
      class_zh: 'α／β 受體阻斷劑', ddd: '37.5 mg (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['dilatrend', '心達悅', '卡維洛爾'] },

    { atc: 'C08CA01', name_en: 'Amlodipine', name_zh: '氨氯地平',
      class_zh: '鈣離子通道阻斷劑（雙氫吡啶類）', ddd: '5 mg (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['norvasc', '脈優', '安脈狄平', 'amlodipine besylate'] },

    { atc: 'C08CA05', name_en: 'Nifedipine', name_zh: '硝苯地平',
      class_zh: '鈣離子通道阻斷劑（雙氫吡啶類）', ddd: '30 mg (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['adalat', '冠達悅', '硝苯吡啶'] },

    { atc: 'C08DA01', name_en: 'Verapamil', name_zh: '維拉帕米',
      class_zh: '鈣離子通道阻斷劑（苯烷胺類）', ddd: '0.24 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['isoptin', '心舒平', '異搏定'] },

    { atc: 'C08DB01', name_en: 'Diltiazem', name_zh: '地爾硫卓',
      class_zh: '鈣離子通道阻斷劑（苯并噻氮平類）', ddd: '0.24 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['herbesser', '合必爽', '硫氮卓酮', 'diltiazem hcl'] },

    // --- 荷爾蒙 ---
    { atc: 'H02AB02', name_en: 'Dexamethasone', name_zh: '地塞米松',
      class_zh: '腎上腺皮質類固醇', ddd: '1.5 mg (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['decadron', '地塞美松', '待克蘇'] },

    // --- 抗感染（本批交互作用最密集的一群：多為 CYP3A4 抑制或誘導） ---
    { atc: 'J01AA02', name_en: 'Doxycycline', name_zh: '多西環素',
      class_zh: '四環素類抗生素', ddd: '0.1 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['vibramycin', '去氧羥四環素', '多喜黴素'] },

    { atc: 'J01FA01', name_en: 'Erythromycin', name_zh: '紅黴素',
      class_zh: '巨環內酯類抗生素', ddd: '1 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['erythrocin', 'erythromycin stearate', '紅霉素'] },

    { atc: 'J01FA09', name_en: 'Clarithromycin', name_zh: '克拉黴素',
      class_zh: '巨環內酯類抗生素', ddd: '0.5 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['klaricid', 'biaxin', '開羅理黴素', '克拉霉素'] },

    { atc: 'J01FA10', name_en: 'Azithromycin', name_zh: '阿奇黴素',
      class_zh: '巨環內酯類抗生素', ddd: '0.3 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['zithromax', '日舒', '阿齊黴素', '阿奇霉素'] },

    { atc: 'J01MA02', name_en: 'Ciprofloxacin', name_zh: '環丙沙星',
      class_zh: '氟喹諾酮類抗生素', ddd: '1 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['cipro', '速博新', '環丙氟哌酸'] },

    { atc: 'J01MA12', name_en: 'Levofloxacin', name_zh: '左氧氟沙星',
      class_zh: '氟喹諾酮類抗生素', ddd: '0.24 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['cravit', '可樂必妥', '左旋氧氟沙星'] },

    // 強效 CYP3A4 誘導劑，與極多藥物有交互作用。美國藥典名為 rifampin。
    { atc: 'J04AB02', name_en: 'Rifampicin', name_zh: '利福平',
      class_zh: '抗結核藥', ddd: '0.6 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['rifampin', 'rifadin', '立汎黴素', '理福黴素'] },

    // --- 免疫抑制劑 ---
    // 【DDInter 寫作 Cyclosporine】同 Glyburide，美國藥典名與 INN 不同。
    { atc: 'L04AD01', name_en: 'Ciclosporin', name_zh: '環孢素',
      class_zh: '免疫抑制劑（鈣調磷酸酶抑制劑）', ddd: '0.25 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['cyclosporine', 'cyclosporin', 'sandimmun', '新體睦', '環孢靈'] },

    { atc: 'L04AD02', name_en: 'Tacrolimus', name_zh: '他克莫司',
      class_zh: '免疫抑制劑（鈣調磷酸酶抑制劑）', ddd: '5 mg (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['prograf', '普樂可復', 'fk506', '他克羅姆'] },

    // --- 肌肉骨骼 ---
    { atc: 'M01AE02', name_en: 'Naproxen', name_zh: '萘普生',
      class_zh: '非類固醇消炎止痛藥（NSAID）', ddd: '0.5 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['naposin', 'naprosyn', '那普洛先', '奈普生'] },

    // --- 神經系統 ---
    { atc: 'N03AB02', name_en: 'Phenytoin', name_zh: '苯妥英',
      class_zh: '抗癲癇藥（乙內醯脲類）', ddd: '0.3 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['dilantin', '癲能停', '苯妥英鈉', 'phenytoin sodium'] },

    { atc: 'N03AF01', name_en: 'Carbamazepine', name_zh: '卡馬西平',
      class_zh: '抗癲癇藥（carboxamide 類）', ddd: '1 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['tegretol', '癲通', '卡巴氮平', '痛痙寧'] },

    { atc: 'N05AB04', name_en: 'Prochlorperazine', name_zh: '丙氯拉嗪',
      class_zh: '抗精神病藥／止吐劑（phenothiazine 類）', ddd: '0.1 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['novamin', 'compazine', '普魯氯嗪', '丙氯培拉嗪'] },

    { atc: 'N05AH02', name_en: 'Clozapine', name_zh: '氯氮平',
      class_zh: '非典型抗精神病藥', ddd: '0.3 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['clozaril', '可致律', '氯薩平'] },

    { atc: 'N05AH04', name_en: 'Quetiapine', name_zh: '喹硫平',
      class_zh: '非典型抗精神病藥', ddd: '0.4 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['seroquel', '思樂康', '奎硫平'] },

    { atc: 'N06AB04', name_en: 'Citalopram', name_zh: '西酞普蘭',
      class_zh: '抗憂鬱劑（SSRI）', ddd: '20 mg (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['celexa', 'cipramil', '西酞普林', '舒憂'] },

    { atc: 'N06AB06', name_en: 'Sertraline', name_zh: '舍曲林',
      class_zh: '抗憂鬱劑（SSRI）', ddd: '50 mg (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['zoloft', '樂復得', '色特寧'] },

    { atc: 'N06AB10', name_en: 'Escitalopram', name_zh: '艾司西酞普蘭',
      class_zh: '抗憂鬱劑（SSRI）', ddd: '10 mg (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['lexapro', 'cipralex', '立普能', '依地普侖'] },

    { atc: 'N06AX16', name_en: 'Venlafaxine', name_zh: '文拉法辛',
      class_zh: '抗憂鬱劑（SNRI）', ddd: '0.1 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['effexor', '速悅', '萬拉法新'] },

    { atc: 'N06AX21', name_en: 'Duloxetine', name_zh: '度洛西汀',
      class_zh: '抗憂鬱劑（SNRI）', ddd: '60 mg (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['cymbalta', '千憂解', '度洛悉汀'] },

    // --- 抗寄生蟲／免疫調節 ---
    { atc: 'P01BA02', name_en: 'Hydroxychloroquine', name_zh: '羥氯喹',
      class_zh: '抗瘧疾藥／抗風濕免疫調節劑', ddd: '0.516 g (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['plaquenil', '必賴克廔', '羥氯奎寧', '氫氧氯奎'] },

    // --- 呼吸系統 ---
    { atc: 'R06AD02', name_en: 'Promethazine', name_zh: '異丙嗪',
      class_zh: '抗組織胺（phenothiazine 類）', ddd: '25 mg (O)', verifiedOn: '2026-09-03',
      atcAliases: [], aliases: ['phenergan', '非那根', '普魯米近', '異丙唪'] }
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
