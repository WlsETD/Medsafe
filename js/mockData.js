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
  ddiRules: [
    { drugA: 'Warfarin', drugB: 'Aspirin', severity: '極高風險', severityClass: 'bg-red-100 text-danger border-red-200', effect: '增加出血風險，需監控 INR 指標。' },
    { drugA: 'Metformin', drugB: 'Iodinated', severity: '高風險', severityClass: 'bg-orange-100 text-warning border-orange-200', effect: '可能誘發乳酸中毒，需停藥。' }
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
      { id: 1, name: 'Warfarin', zhName: '華法林', dosage: '5mg', freq: '每日一次 (晚)', category: '抗凝血劑', status: '風險', color: 'danger', icon: 'shield-exclamation', hospital: '台大醫院' },
      { id: 2, name: 'Aspirin', zhName: '阿斯匹靈', dosage: '100mg', freq: '每日一次 (早)', category: '非類固醇消炎藥', status: '風險', color: 'danger', icon: 'shield-exclamation', hospital: '長庚醫院' },
      { id: 3, name: 'Metformin', zhName: '二甲雙胍', dosage: '500mg', freq: '每日兩次 (飯後)', category: '降血糖藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '榮總醫院' },
      { id: 4, name: 'Lisinopril', zhName: '賴諾普利', dosage: '10mg', freq: '每日一次 (早)', category: '降血壓藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '台大醫院' },
      { id: 5, name: 'Vitamin D3', zhName: '維生素 D3', dosage: '1000IU', freq: '每日一次', category: '營養補充', status: '安全', color: 'success', icon: 'check-circle', hospital: '馬偕醫院' },
      { id: 6, name: 'Multivitamin', zhName: '綜合維他命', dosage: '1錠', freq: '每日一次', category: '營養補充', status: '安全', color: 'success', icon: 'check-circle', hospital: '台大醫院' }
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
        { id: 1, name: 'Metformin', zhName: '二甲雙胍', dosage: '500mg', freq: '每日兩次 (飯後)', category: '降血糖藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '榮總醫院' },
        { id: 2, name: 'Lisinopril', zhName: '賴諾普利', dosage: '10mg', freq: '每日一次 (早)', category: '降血壓藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '台大醫院' },
        { id: 3, name: 'Atorvastatin', zhName: '阿托伐他汀', dosage: '20mg', freq: '睡前一次', category: '降血脂藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '馬偕醫院' }
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
        { id: 1, name: 'Metformin', zhName: '二甲雙胍', dosage: '500mg', freq: '每日兩次 (飯後)', category: '降血糖藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '榮總醫院' },
        { id: 2, name: 'Lisinopril', zhName: '賴諾普利', dosage: '10mg', freq: '每日一次 (早)', category: '降血壓藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '台大醫院' },
        { id: 3, name: 'Atorvastatin', zhName: '阿托伐他汀', dosage: '20mg', freq: '睡前一次', category: '降血脂藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '馬偕醫院' }
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
        { id: 1, name: 'Metformin', zhName: '二甲雙胍', dosage: '500mg', freq: '每日兩次 (飯後)', category: '降血糖藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '榮總醫院' },
        { id: 2, name: 'Lisinopril', zhName: '賴諾普利', dosage: '10mg', freq: '每日一次 (早)', category: '降血壓藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '台大醫院' },
        { id: 3, name: 'Atorvastatin', zhName: '阿托伐他汀', dosage: '20mg', freq: '睡前一次', category: '降血脂藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '馬偕醫院' }
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
        { id: 1, name: 'Warfarin', zhName: '華法林', dosage: '5mg', freq: '每日一次 (晚)', category: '抗凝血劑', status: '風險', color: 'danger', icon: 'shield-exclamation', hospital: '台大醫院' },
        { id: 2, name: 'Aspirin', zhName: '阿斯匹靈', dosage: '100mg', freq: '每日一次 (早)', category: '非類固醇消炎藥', status: '風險', color: 'danger', icon: 'shield-exclamation', hospital: '長庚醫院' },
        { id: 3, name: 'Amiodarone', zhName: '胺碘酮', dosage: '200mg', freq: '每日一次', category: '抗心律不整藥', status: '風險', color: 'danger', icon: 'shield-exclamation', hospital: '成大醫院' },
        { id: 4, name: 'Metformin', zhName: '二甲雙胍', dosage: '500mg', freq: '每日兩次 (飯後)', category: '降血糖藥', status: '安全', color: 'success', icon: 'check-circle', hospital: '榮總醫院' }
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
    { id: 1, name: 'Warfarin', zhName: '華法林', category: '抗凝血劑', dosage: '5mg', unit: '錠', stock: 1200, price: 15, status: '正常', location: 'A-01' },
    { id: 2, name: 'Aspirin', zhName: '阿斯匹靈', category: '非類固醇消炎藥', dosage: '100mg', unit: '錠', stock: 2500, price: 5, status: '正常', location: 'A-02' },
    { id: 3, name: 'Metformin', zhName: '二甲雙胍', category: '降血糖藥', dosage: '500mg', unit: '錠', stock: 3000, price: 8, status: '正常', location: 'B-01' },
    { id: 4, name: 'Lisinopril', zhName: '賴諾普利', category: '降血壓藥', dosage: '10mg', unit: '錠', stock: 1500, price: 12, status: '正常', location: 'B-02' }
  ],

  // -------------------------------------------------------------------
  // 藥物交互作用網狀圖資料 (D3.js)
  // -------------------------------------------------------------------
  graphData: {
    nodes: [
      { id: "Warfarin", name_en: "Warfarin", name_zh: "華法林", hospital: "台大醫院", conflict: true, dosage: "5mg", freq: "每日一次" },
      { id: "Aspirin", name_en: "Aspirin", name_zh: "阿斯匹靈", hospital: "長庚醫院", conflict: true, dosage: "100mg", freq: "每日一次" },
      { id: "Amiodarone", name_en: "Amiodarone", name_zh: "胺碘酮", hospital: "成大醫院", conflict: true, dosage: "200mg", freq: "每日一次" },
      { id: "Metformin", name_en: "Metformin", name_zh: "二甲雙胍", hospital: "榮總醫院", conflict: false, dosage: "500mg", freq: "每日兩次" },
      { id: "Lisinopril", name_en: "Lisinopril", name_zh: "賴諾普利", hospital: "台大醫院", conflict: false, dosage: "10mg", freq: "每日一次" },
      { id: "Atorvastatin", name_en: "Atorvastatin", name_zh: "阿托伐他汀", hospital: "馬偕醫院", conflict: false, dosage: "20mg", freq: "睡前一次" }
    ],
    links: [
      { source: "Warfarin", target: "Aspirin", conflict: true, effect: "高風險：增加嚴重的胃腸道出血與內出血風險。", recommendation: "避免合併使用，或需嚴密監測 INR 值與出血徵兆。" },
      { source: "Warfarin", target: "Amiodarone", conflict: true, effect: "高風險：顯著提升藥物血中濃度，易導致抗凝效果過強。", recommendation: "建議劑量減半，並密切監測凝血指標。" }
    ],
    scenarios: {
      A: ["Warfarin", "Aspirin", "Metformin", "Amiodarone"],
      B: ["Metformin", "Lisinopril", "Atorvastatin"]
    }
  }
};
