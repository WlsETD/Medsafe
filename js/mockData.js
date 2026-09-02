window.mockData = {
  // 展示帳號名冊（僅角色與姓名，供介面顯示用）
  // 此處刻意不含任何密碼：純前端專案的所有內容皆可被公開下載，
  // 在此放置憑證等同於對外發佈可用帳密。一鍵登入的憑證只保留低權限帳號，見 login.html。
  users: [
    { username: 'admin', role: 'admin', name: '王大明主任' },
    { username: 'doctor', role: 'doctor', name: '李小美醫師' },
    { username: 'patient01', role: 'patient', name: '王大明' },
    { username: 'insurance01', role: 'insurance', name: '國泰核保員' },
    { username: 'P001', role: 'patient', name: '張小泉' },
    { username: 'P002', role: 'patient', name: '李大維' },
    { username: 'P003', role: 'patient', name: '陳美花' },
    { username: 'P004', role: 'patient', name: '劉建國' }
  ],

  // DDI 交互規則（供 admin.html 用戶管理頁與 seed.html 使用）
  // 交互作用規則庫（離線內建）。雲端 ddi_rules 為「補充」而非「取代」——
  // 見 dashboard.html 的說明。比對由 js/ddi-engine.js 以 ATC 碼進行，非藥名字串。
  //
  // 【每條規則都必須帶 source 與 reviewedOn】
  // 原因見下方 Metformin × 顯影劑那條：它原本寫「可能誘發乳酸中毒，需停藥」，
  // 但 ACR 現行指引早已改為「eGFR ≥30 不需停藥」，2025 年連 30–44 的暫停建議也取消了。
  // 一條沒有出處的規則無從複核，而臨床指引會變、變了不會有人通知你。
  // 無條件叫糖尿病患停藥本身就是傷害（高血糖），錯誤的警示與漏掉的警示都會害人。
  //
  // 本規則庫僅涵蓋目錄中 9 種藥物之間有實證記載的組合，共 5 條。
  // 未列出的組合代表「本知識庫未收錄」，不代表「已確認無交互作用」——
  // 這個區別由引擎的 verdict 與 UI 措辭共同守住（P0-3）。
  ddiRules: [
    {
      drugA: 'Warfarin', drugB: 'Aspirin', atcA: 'B01AA03', atcB: 'B01AC06',
      severity: 'major',
      effect: '併用顯著提高出血風險（包含胃腸道出血與顱內出血）。Aspirin 抑制血小板功能並可能損傷胃黏膜，與 Warfarin 的抗凝作用相加。',
      recommendation: '除有明確適應症（如機械瓣膜、近期急性冠心症）外應避免併用。若必須併用，需嚴密監測 INR 與出血徵兆，並評估加用氫離子幫浦阻斷劑保護胃黏膜。',
      source: 'ACC/AHA 抗栓治療指引；製造商仿單交互作用章節',
      reviewedOn: '2026-09-02'
    },
    {
      drugA: 'Warfarin', drugB: 'Amiodarone', atcA: 'B01AA03', atcB: 'C01BD01',
      severity: 'major',
      effect: 'Amiodarone 抑制 CYP2C9，減緩 Warfarin 代謝，使血中濃度與 INR 顯著上升，出血風險增加。此作用起效慢、消退更慢（Amiodarone 半衰期可達數十天），停藥後影響仍會持續數週。',
      recommendation: '開始併用時通常需將 Warfarin 劑量下調約 30–50%，並在起始後數週內密集監測 INR。Amiodarone 停用後亦須持續追蹤 INR，不可立即回復原劑量。',
      source: '製造商仿單交互作用章節；CYP2C9 抑制之藥動學文獻',
      reviewedOn: '2026-09-02'
    },
    {
      drugA: 'Amiodarone', drugB: 'Atorvastatin', atcA: 'C01BD01', atcB: 'C10AA05',
      severity: 'moderate',
      effect: 'Amiodarone 抑制 CYP3A4，提高 Atorvastatin 血中濃度，增加肌肉毒性（肌病變、橫紋肌溶解）風險。年長者、腎功能或肝功能不佳者風險較高。',
      recommendation: '併用時建議 Atorvastatin 每日劑量不超過 20 mg，並衛教病患留意不明原因的肌肉疼痛、無力或深色尿。必要時改用不經 CYP3A4 代謝的 statin（如 pravastatin、rosuvastatin）。',
      source: 'AHA 科學聲明「Statin 與其他藥物之臨床顯著交互作用之處理建議」（Circulation, 2016）',
      reviewedOn: '2026-09-02'
    },
    {
      // 【本條為修正後版本】原內容為「可能誘發乳酸中毒，需停藥」，已不符現行指引。
      drugA: 'Metformin', drugB: 'Iodinated', atcA: 'A10BA02', atcB: 'V08A',
      severity: 'moderate',
      effect: '顯影劑若造成急性腎損傷，可能使 Metformin 蓄積而誘發乳酸中毒。乳酸中毒罕見但可致命；然而在腎功能正常者身上，此風險極低。',
      recommendation: '依 ACR 指引分兩種情況：eGFR ≥30 且無急性腎損傷者，靜脈注射顯影劑前後「均不需」停用 Metformin，亦無強制複驗腎功能之必要；eGFR <30、已有急性腎損傷，或接受可能造成腎動脈栓塞之動脈導管檢查者，應於檢查前後停用 Metformin 48 小時，待腎功能複評後再恢復。請確認病患的 eGFR 後再決定。',
      source: 'ACR Manual on Contrast Media（含 2025 年更新：原 eGFR 30–44 需停藥之建議已取消）',
      reviewedOn: '2026-09-02'
    },
    {
      // 分寸很重要：這條的正確訊息是「維持穩定並監測」，不是「危險、應避免」。
      // 把輕微交互作用講成重大，會導致病患自行停用營養補充品或恐慌，同樣是傷害。
      drugA: 'Warfarin', drugB: 'Multivitamin', atcA: 'B01AA03', atcB: 'A11A',
      severity: 'minor',
      effect: '綜合維他命中的維生素 K1 會拮抗 Warfarin 的抗凝作用而降低 INR。市售產品的維生素 K1 含量通常低於足以影響抗凝的劑量，但已有病例報告顯示穩定服用 Warfarin 的病患在開始服用綜合維他命後 INR 下降。反之，突然停用亦可能使 INR 上升。',
      recommendation: '不需禁止併用，但維生素 K 的攝取量應維持穩定，勿忽然開始或忽然停用。開始或停用時應通知醫師並加密監測 INR。請攜帶實際產品向藥師確認其維生素 K 含量。',
      source: 'Drugs.com 專業版交互作用專論（vitamin K × warfarin）；維生素 K1 綜合維他命對 INR 影響之臨床研究',
      reviewedOn: '2026-09-02'
    }
  ],

  // 管理員端數據
  admin: {
    maintenanceMode: false,
    stats: {
      totalUsers: 4500,
      totalHospitals: 24,
      systemUptime: '99.9%',
      securityAlerts: 0,
      totalDdiRules: 12450,
      aiAnalyticsCount: 8920,
      todayApiCalls: 15620,
      dataStorageAmount: '2.4 TB'
    },
    aiTrendData: [450, 590, 820, 710, 950, 1100, 1280],
    ddiRiskLevels: [120, 85, 45, 10],
    medicationCategories: [
      { label: '心血管', value: 450 },
      { label: '神經系統', value: 320 },
      { label: '消化道', value: 210 },
      { label: '抗感染', value: 150 },
      { label: '內分泌', value: 80 }
    ],
    dataSyncTrend: [120, 150, 180, 160, 210, 240, 280],
    logs: [
      { time: '10:24:15', user: '李小美醫師', action: 'AI 交互分析完成', type: 'ai', status: '成功' },
      { time: '09:45:02', user: '系統', action: '新 DDI 規則更新', type: 'rule', status: '成功' },
      { time: '08:30:00', user: '系統', action: '資料同步成功', type: 'network', status: '成功' },
      { time: '07:15:22', user: '系統', action: '保險資料同步完成', type: 'insurance', status: '成功' }
    ],
    systemStatus: {
      apiHealth: 98,
      aiEngine: 95,
      secureNetwork: 100,
      database: 92
    }
  },

  // 醫師端數據
  doctor: {
    stats: {
      totalPatients: 1250,
      activePrescriptions: 450,
      conflictAlerts: 12,
      safetyRate: 98.5
    },
    prescriptionsByMonth: [65, 59, 80, 81, 56, 55, 40],
    conflictRates: [2.5, 2.1, 3.0, 1.8, 2.4, 1.5, 1.2],
    categoryDistribution: [
      { label: '心血管用藥', value: 300 },
      { label: '糖尿病用藥', value: 250 },
      { label: '抗生素', value: 150 },
      { label: '止痛藥', value: 200 },
      { label: '其他', value: 100 }
    ],
    recentPatients: [
      { id: 'patient01', name: '王大明', status: '警告', lastCheck: '2025-05-25' },
      { id: 'P004', name: '劉建國', status: '危險', lastCheck: '2025-05-24' },
      { id: 'P001', name: '張小泉', status: '安全', lastCheck: '2025-05-20' },
      { id: 'P002', name: '李大維', status: '警告', lastCheck: '2025-05-22' },
      { id: 'P003', name: '陳美花', status: '安全', lastCheck: '2025-05-23' }
    ]
  },

  // 患者端數據
  patient: {
    assignedDoctor: 'doctor',
    assignedDoctorName: '李小美醫師',
    profile: {
      id: 'patient01',
      name: '王大明',
      age: 72,
      gender: '男',
      healthSummary: '目前用藥狀況穩定，但需注意血壓藥與抗凝血劑的潛在交互作用。',
      nextAppointment: '2026-09-01'
    },
    // safetyScore 不再寫死於資料中，改由 DbService.computeSafetyScore() 依 medications/ddiAlerts 即時計算
    stats: {
      activeMeds: 6,
      aiChecksToday: 12,
      lastSync: '5 分鐘前'
    },
    medications: [
      { atc: 'B01AA03', name: 'Warfarin', zhName: '華法林', dosage: '5mg', freq: '每日一次 (晚)', category: '抗凝血劑', status: '風險', color: 'danger', icon: 'shield-exclamation', hospital: '台大醫院' },
      { atc: 'B01AC06', name: 'Aspirin', zhName: '阿斯匹靈', dosage: '100mg', freq: '每日一次 (早)', category: '非類固醇消炎藥', status: '風險', color: 'danger', icon: 'shield-exclamation', hospital: '長庚醫院' },
      { atc: 'A10BA02', name: 'Metformin', zhName: '二甲雙胍', dosage: '500mg', freq: '每日兩次 (飯後)', category: '降血糖藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '榮總醫院' },
      { atc: 'C09AA03', name: 'Lisinopril', zhName: '賴諾普利', dosage: '10mg', freq: '每日一次 (早)', category: '降血壓藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '台大醫院' },
      { atc: 'A11CC05', name: 'Vitamin D3', zhName: '維生素 D3', dosage: '1000IU', freq: '每日一次', category: '營養補充', status: '安全', color: 'success', icon: 'check-circle', hospital: '馬偕醫院' },
      { atc: 'A11A', name: 'Multivitamin', zhName: '綜合維他命', dosage: '1錠', freq: '每日一次', category: '營養補充', status: '安全', color: 'success', icon: 'check-circle', hospital: '台大醫院' }
    ],
    ddiAlerts: [
      { 
        id: 'A001', 
        drugs: ['Warfarin', 'Aspirin'], 
        severity: '極高風險', 
        message: '同時服用華法林與阿斯匹靈會顯著增加胃腸道出血風險。', 
        recommendation: '請諮詢李小美醫師是否需要調整抗血小板藥物劑量。'
      }
    ],
    aiInsights: [
      { icon: 'clock', text: '您的用藥規律性優於 85% 的用戶，請繼續保持。' },
      { icon: 'info-circle', text: '近期攝取過多葡萄柚可能影響藥物代謝。' },
      { icon: 'calendar-check', text: '下週三有定期回診，系統已為您備份近期安全日誌。' }
    ],
    reminders: [
      { time: '08:00', text: '服用阿斯匹靈、賴諾普利', completed: true },
      { time: '12:00', text: '服用二甲雙胍 (飯後)', completed: false },
      { time: '20:00', text: '服用華法林', completed: false }
    ]
  },

  // 其他真實患者帳號（醫師端病患清單 P001-P004，現為可獨立登入的真實帳戶）
  patients: {
    P001: {
      assignedDoctor: 'doctor',
      assignedDoctorName: '李小美醫師',
      profile: {
        id: 'P001', name: '張小泉', age: 68, gender: '女',
        healthSummary: '目前用藥狀況穩定，無重大交互作用風險。',
        nextAppointment: '2024-06-20'
      },
      stats: { activeMeds: 3, aiChecksToday: 8, lastSync: '10 分鐘前' },
      medications: [
        { atc: 'A10BA02', name: 'Metformin', zhName: '二甲雙胍', dosage: '500mg', freq: '每日兩次 (飯後)', category: '降血糖藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '榮總醫院' },
        { atc: 'C09AA03', name: 'Lisinopril', zhName: '賴諾普利', dosage: '10mg', freq: '每日一次 (早)', category: '降血壓藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '台大醫院' },
        { atc: 'C10AA05', name: 'Atorvastatin', zhName: '阿托伐他汀', dosage: '20mg', freq: '睡前一次', category: '降血脂藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '馬偕醫院' }
      ],
      ddiAlerts: [],
      aiInsights: [
        { icon: 'clock', text: '您的用藥規律性優於 90% 的用戶，請繼續保持。' },
        { icon: 'info-circle', text: '近期血糖控制穩定，建議維持現有飲食習慣。' }
      ],
      reminders: [
        { time: '08:00', text: '服用賴諾普利', completed: true },
        { time: '12:00', text: '服用二甲雙胍 (飯後)', completed: false },
        { time: '22:00', text: '服用阿托伐他汀', completed: false }
      ]
    },
    P002: {
      assignedDoctor: 'doctor',
      assignedDoctorName: '李小美醫師',
      profile: {
        id: 'P002', name: '李大維', age: 75, gender: '男',
        healthSummary: '用藥品項較多，AI 已加強監控潛在交互作用風險。',
        nextAppointment: '2024-06-18'
      },
      stats: { activeMeds: 3, aiChecksToday: 10, lastSync: '25 分鐘前' },
      medications: [
        { atc: 'A10BA02', name: 'Metformin', zhName: '二甲雙胍', dosage: '500mg', freq: '每日兩次 (飯後)', category: '降血糖藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '榮總醫院' },
        { atc: 'C09AA03', name: 'Lisinopril', zhName: '賴諾普利', dosage: '10mg', freq: '每日一次 (早)', category: '降血壓藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '台大醫院' },
        { atc: 'C10AA05', name: 'Atorvastatin', zhName: '阿托伐他汀', dosage: '20mg', freq: '睡前一次', category: '降血脂藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '馬偕醫院' }
      ],
      ddiAlerts: [],
      aiInsights: [
        { icon: 'info-circle', text: '您的用藥品項較多，AI 已加強監控交互作用風險。' },
        { icon: 'calendar-check', text: '建議下次回診時攜帶所有藥物清單供醫師確認。' }
      ],
      reminders: [
        { time: '08:00', text: '服用賴諾普利、阿托伐他汀', completed: false },
        { time: '12:00', text: '服用二甲雙胍 (飯後)', completed: false },
        { time: '18:00', text: '服用二甲雙胍 (飯後)', completed: false }
      ]
    },
    P003: {
      assignedDoctor: 'doctor',
      assignedDoctorName: '李小美醫師',
      profile: {
        id: 'P003', name: '陳美花', age: 70, gender: '女',
        healthSummary: '目前用藥狀況穩定，無重大交互作用風險。',
        nextAppointment: '2024-06-22'
      },
      stats: { activeMeds: 3, aiChecksToday: 9, lastSync: '18 分鐘前' },
      medications: [
        { atc: 'A10BA02', name: 'Metformin', zhName: '二甲雙胍', dosage: '500mg', freq: '每日兩次 (飯後)', category: '降血糖藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '榮總醫院' },
        { atc: 'C09AA03', name: 'Lisinopril', zhName: '賴諾普利', dosage: '10mg', freq: '每日一次 (早)', category: '降血壓藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '台大醫院' },
        { atc: 'C10AA05', name: 'Atorvastatin', zhName: '阿托伐他汀', dosage: '20mg', freq: '睡前一次', category: '降血脂藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '馬偕醫院' }
      ],
      ddiAlerts: [],
      aiInsights: [
        { icon: 'clock', text: '您的用藥規律性優於 88% 的用戶，請繼續保持。' },
        { icon: 'calendar-check', text: '下次回診已排定，系統已為您備份近期安全日誌。' }
      ],
      reminders: [
        { time: '08:00', text: '服用賴諾普利', completed: true },
        { time: '12:00', text: '服用二甲雙胍 (飯後)', completed: true },
        { time: '22:00', text: '服用阿托伐他汀', completed: false }
      ]
    },
    P004: {
      assignedDoctor: 'doctor',
      assignedDoctorName: '李小美醫師',
      profile: {
        id: 'P004', name: '劉建國', age: 66, gender: '男',
        healthSummary: '目前用藥狀況需注意，血壓藥與抗凝血劑存在潛在交互作用。',
        nextAppointment: '2024-06-16'
      },
      stats: { activeMeds: 4, aiChecksToday: 14, lastSync: '3 分鐘前' },
      medications: [
        { atc: 'B01AA03', name: 'Warfarin', zhName: '華法林', dosage: '5mg', freq: '每日一次 (晚)', category: '抗凝血劑', status: '風險', color: 'danger', icon: 'shield-exclamation', hospital: '台大醫院' },
        { atc: 'B01AC06', name: 'Aspirin', zhName: '阿斯匹靈', dosage: '100mg', freq: '每日一次 (早)', category: '非類固醇消炎藥', status: '風險', color: 'danger', icon: 'shield-exclamation', hospital: '長庚醫院' },
        { atc: 'C01BD01', name: 'Amiodarone', zhName: '胺碘酮', dosage: '200mg', freq: '每日一次', category: '抗心律不整藥', status: '風險', color: 'danger', icon: 'shield-exclamation', hospital: '成大醫院' },
        { atc: 'A10BA02', name: 'Metformin', zhName: '二甲雙胍', dosage: '500mg', freq: '每日兩次 (飯後)', category: '降血糖藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '榮總醫院' }
      ],
      ddiAlerts: [
        {
          id: 'B001',
          drugs: ['Warfarin', 'Aspirin'],
          severity: '極高風險',
          message: '同時服用華法林與阿斯匹靈會顯著增加胃腸道出血風險。',
          recommendation: '請諮詢李小美醫師是否需要調整抗血小板藥物劑量。'
        },
        {
          id: 'B002',
          drugs: ['Warfarin', 'Amiodarone'],
          severity: '高風險',
          message: '胺碘酮會顯著提升華法林血中濃度，易導致抗凝效果過強。',
          recommendation: '建議劑量減半，並密切監測 INR 凝血指標。'
        }
      ],
      aiInsights: [
        { icon: 'info-circle', text: '偵測到您同時服用華法林與阿斯匹靈，請留意出血徵兆。' },
        { icon: 'calendar-check', text: '系統已通知主治醫師，建議儘速安排回診。' }
      ],
      reminders: [
        { time: '08:00', text: '服用阿斯匹靈', completed: true },
        { time: '12:00', text: '服用二甲雙胍 (飯後)', completed: false },
        { time: '20:00', text: '服用華法林、胺碘酮', completed: false }
      ]
    }
  },

  // 保險端數據
  insurance: {
    stats: {
      activePolicies: 12450,
      claimsProcessed: 892,
      aiRiskAnalysis: 3420,
      premiumDiscounts: 'NT$ 2.4M',
      coverageHealth: 94.2,
      securityVerification: '100%'
    },
    claimsTrend: [65, 59, 80, 81, 56, 55, 72],
    riskRadar: [85, 90, 70, 80, 75],
    discountsMonthly: [120000, 150000, 140000, 180000, 160000, 210000, 195000],
    aiPredictionTrend: [25, 22, 18, 15, 12, 10, 8],
    claimsTracking: [
      { id: 'CLM-8821', customer: '王大明', amount: 'NT$ 1,200', status: 'Approved', statusClass: 'text-turquoise bg-turquoise/10', time: '2小時前', progress: 100 },
      { id: 'CLM-8822', customer: '陳小美', amount: 'NT$ 4,500', status: 'Processing', statusClass: 'text-yellow-500 bg-yellow-50', time: '5小時前', progress: 65 },
      { id: 'CLM-8823', customer: '李國華', amount: 'NT$ 850', status: 'AI Reviewing', statusClass: 'text-indigo-500 bg-indigo-50', time: '1天前', progress: 40 },
      { id: 'CLM-8824', customer: '張健', amount: 'NT$ 2,300', status: 'Pending Documents', statusClass: 'text-gray-500 bg-gray-50', time: '2天前', progress: 20 },
    ],
    coverageGaps: [
      { type: '心血管疾病額度不足', customerCount: 450, riskLevel: 'High', recommendation: '建議調增 20% 醫療額度' },
      { type: '藥物衝突高風險群', customerCount: 120, riskLevel: 'Critical', recommendation: '啟動 AI 即時用藥監控專案' },
      { type: '年長保戶長照缺口', customerCount: 890, riskLevel: 'Medium', recommendation: '推出專屬長照附加條款' }
    ],
    topSafeUsers: [
      { name: '王大明', score: 98, discount: 'NT$ 2,500' },
      { name: '陳小美', score: 97, discount: 'NT$ 2,300' },
      { name: '李國華', score: 96, discount: 'NT$ 2,100' }
    ]
  },

  // 全域藥品清單
  allMedications: [
    { atc: 'B01AA03', name: 'Warfarin', zhName: '華法林', category: '抗凝血劑', dosage: '5mg', unit: '錠', stock: 1200, price: 15, status: '正常', location: 'A-01' },
    { atc: 'B01AC06', name: 'Aspirin', zhName: '阿斯匹靈', category: '非類固醇消炎藥', dosage: '100mg', unit: '錠', stock: 2500, price: 5, status: '正常', location: 'A-02' },
    { atc: 'A10BA02', name: 'Metformin', zhName: '二甲雙胍', category: '降血糖藥', dosage: '500mg', unit: '錠', stock: 3000, price: 8, status: '正常', location: 'B-01' },
    { atc: 'C09AA03', name: 'Lisinopril', zhName: '賴諾普利', category: '降血壓藥', dosage: '10mg', unit: '錠', stock: 1500, price: 12, status: '正常', location: 'B-02' },
    { atc: 'C01BD01', name: 'Amiodarone', zhName: '胺碘酮', category: '抗心律不整劑', dosage: '200mg', unit: '錠', stock: 800, price: 22, status: '正常', location: 'A-03' },
    { atc: 'C10AA05', name: 'Atorvastatin', zhName: '阿托伐他汀', category: '降血脂藥', dosage: '20mg', unit: '錠', stock: 2200, price: 18, status: '正常', location: 'B-03' },
    { atc: 'A11CC05', name: 'Vitamin D3', zhName: '維生素 D3', category: '營養補充', dosage: '1000IU', unit: '錠', stock: 4000, price: 3, status: '正常', location: 'C-01' },
    { atc: 'A11A', name: 'Multivitamin', zhName: '綜合維他命', category: '營養補充（複方）', dosage: '1錠', unit: '錠', stock: 3500, price: 6, status: '正常', location: 'C-02' }
  ],

  // -------------------------------------------------------------------
  // 藥物交互作用網狀圖資料 (D3.js)
  // -------------------------------------------------------------------
  graphData: {
    nodes: [
      { id: "Warfarin", atc: "B01AA03", name_en: "Warfarin", name_zh: "華法林", hospital: "台大醫院", conflict: true, dosage: "5mg", freq: "每日一次" },
      { id: "Aspirin", atc: "B01AC06", name_en: "Aspirin", name_zh: "阿斯匹靈", hospital: "長庚醫院", conflict: true, dosage: "100mg", freq: "每日一次" },
      { id: "Amiodarone", atc: "C01BD01", name_en: "Amiodarone", name_zh: "胺碘酮", hospital: "成大醫院", conflict: true, dosage: "200mg", freq: "每日一次" },
      { id: "Metformin", atc: "A10BA02", name_en: "Metformin", name_zh: "二甲雙胍", hospital: "榮總醫院", conflict: false, dosage: "500mg", freq: "每日兩次" },
      { id: "Lisinopril", atc: "C09AA03", name_en: "Lisinopril", name_zh: "賴諾普利", hospital: "台大醫院", conflict: false, dosage: "10mg", freq: "每日一次" },
      { id: "Atorvastatin", atc: "C10AA05", name_en: "Atorvastatin", name_zh: "阿托伐他汀", hospital: "馬偕醫院", conflict: false, dosage: "20mg", freq: "睡前一次" }
    ],
    links: [
      { source: "Warfarin", target: "Aspirin", atcSource: "B01AA03", atcTarget: "B01AC06", conflict: true, effect: "高風險：增加嚴重的胃腸道出血與內出血風險。", recommendation: "避免合併使用，或需嚴密監測 INR 值與出血徵兆。" },
      { source: "Warfarin", target: "Amiodarone", atcSource: "B01AA03", atcTarget: "C01BD01", conflict: true, effect: "高風險：顯著提升藥物血中濃度，易導致抗凝效果過強。", recommendation: "建議劑量減半，並密切監測凝血指標。" }
    ],
    scenarios: {
      A: ["Warfarin", "Aspirin", "Metformin", "Amiodarone"],
      B: ["Metformin", "Lisinopril", "Atorvastatin"]
    }
  }
};
