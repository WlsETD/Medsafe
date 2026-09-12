// 展示帳號重置（公開票選期資料清潔工具）
//
// 【問題】login.html 的一鍵登入讓任何訪客都能以 patient01/doctor/insurance01
// 操作系統（admin 需輸入密碼，但密碼同樣公開於 README）。公開票選期間，
// 任何人都可能在這些帳號底下留下測試用的髒資料——亂打的用藥、亂建的理賠
// 個案、聊天室裡的任意文字。評審或後續訪客打開展示帳號時，看到的可能是
// 上一位訪客留下的殘局，而不是這個系統原本要展示的樣子。
//
// 【這個檔案做什麼】把 patient01/P001–P004（連同 doctor/insurance01 共用的
// 保險與照護個案集合）覆寫回一份乾淨、內部一致的示範資料——藥物組合對得上
// mockData.ddiRules 的既有規則，日期一律用「距今天數」而非寫死的絕對日期
// （寫死日期必然變成過去式，見 mockData.js patient.profile 的既有教訓）。
//
// 【誰能執行、誰不受影響】僅 admin 可觸發（firestore.rules 的 isAdmin() 分支）。
// 白名單以外的帳號（包含所有自助註冊的真實使用者）完全不受影響——本檔案
// 從不對白名單外的 username 發出任何寫入或刪除。醫病對話的刪除額外受
// firestore.rules 的 isDemoPatientUsername() 把關，兩處清單必須同步：
// 改這裡的 DEMO_PATIENTS 時，務必同步修改 firestore.rules 與
// tests/firestore-rules.test.mjs 的對應測試。
//
// 【刻意不做的事】
//   - 不刪除 appointments（firestore.rules 對它的 delete 一律為 false，
//     這是刻意的病歷不可竄改設計，reset 不應該、也做不到繞過它）。
//     改為把白名單病患名下「進行中」的舊掛號狀態改為 cancelled（合法的
//     status 更新），並補一筆新的示範掛號，讓畫面不至於空白或卡在舊資料。
//   - 不動 care_relations / consents（同樣是刪除永遠被拒的證據型集合，
//     且 admin 對它們也沒有 create/update 權限）。過期的照護關係會在
//     hasActiveCareRelation() 判斷時自然失效，不需要、也無法主動清除。
//   - 不動 doctor_data/main、insurance_data/main：db-service.js 沒有任何
//     路徑會寫入這兩份文件，它們是靜態設定，不會被展示過程污染。
//   - 不清 appointment_counters：號碼一經發出就固定、取消不遞補（見
//     firestore.rules 的門診班表一節），把計數器歸零會讓新掛號拿到
//     已經有人用過的號碼，也就會撞上既有掛號文件而整批寫入失敗。
//     示範用的號碼從目前的數字繼續往下發即可。
//   - doctor_schedules/doctor 則是「重設」而非「不動」：它是示範醫師的
//     門診班表，沒有它病患端就看不到叫號預約這個功能。
window.DemoReset = (function () {

  // 與 firestore.rules 的 isDemoPatientUsername() 保持一致——見該處註解。
  const DEMO_PATIENTS = ['patient01', 'P001', 'P002', 'P003', 'P004'];
  const DEMO_DOCTOR = 'doctor';
  const COOLDOWN_MS = 60 * 1000;
  const STATE_DOC = 'admin_data/demoReset';

  // ── 內容雜湊：與 insurance.html 的 contentDigest() 相同算法 ───────────
  // 保單的 hash 欄位語意是「由保單內容決定的檢查碼」（對抗性稽核 H-10），
  // 重置產生的保單同樣要滿足這個語意，而不是塞一個看起來像雜湊的字面值。
  async function contentDigest(parts) {
    const input = parts.join('');
    if (!(window.crypto && window.crypto.subtle)) return 'SEC-000000';
    const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return 'SEC-' + Array.from(new Uint8Array(buf)).slice(0, 6)
      .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  // 每一筆用藥都帶完整的 safetyCheck，不只是陣列最後一筆——
  // firestore.rules 的 prescriptionIsAccountable() 只在「用藥清單變長」時
  // 檢查最後一筆，但重置前的髒資料長度未知（可能被訪客清空、也可能被
  // 塞了一堆亂打的藥），寫回的清單相對舊清單「變長」與否無法預先保證。
  // 每筆都帶齊，不論規則檢查的是哪一筆都不會被擋下。
  function med(atc, name, zhName, dosage, freq, category, hospital, verdict, overrideReason) {
    const safetyCheck = {
      verdict, checkedAt: new Date().toISOString(), by: 'system-demo-reset'
    };
    if (verdict === 'risk') safetyCheck.overrideReason = overrideReason || '示範資料：對應既有 DDI 規則庫的已知交互作用，僅供展示。';
    return { atc, name, zhName, dosage, freq, category, hospital, safetyCheck };
  }

  // ── 病患種子資料 ────────────────────────────────────────────────────
  // 用藥組合刻意對應 mockData.ddiRules 裡確實存在的規則，讓 DDI 偵測、
  // 醫師端關係圖與這裡的 ddiAlerts 三處呈現一致，而非各自表述。
  function patientSeed(username) {
    const common = {
      assignedDoctor: DEMO_DOCTOR,
      assignedDoctorName: '李小美醫師',
      stats: { safetyScore: null, activeMeds: 0, aiChecksToday: 0, lastSync: '尚未同步' },
      ddiAlerts: [],
      reminders: []
    };
    switch (username) {
      case 'patient01':
        return Object.assign({}, common, {
          profile: {
            id: 'patient01', name: '王大明', nationalId: 'A123456789',
            age: 72, gender: '男', nextAppointmentInDays: 12
          },
          stats: Object.assign({}, common.stats, { activeMeds: 6 }),
          medications: [
            med('B01AA03', 'Warfarin', '華法林', '5mg', '每日一次 (晚)', '抗凝血劑', '台大醫院', 'risk'),
            med('B01AC06', 'Aspirin', '阿斯匹靈', '100mg', '每日一次 (早)', '非類固醇消炎藥', '長庚醫院', 'risk'),
            med('A10BA02', 'Metformin', '二甲雙胍', '500mg', '每日兩次 (飯後)', '降血糖藥', '榮總醫院', 'no-known-interaction'),
            med('C09AA03', 'Lisinopril', '賴諾普利', '10mg', '每日一次 (早)', '降血壓藥', '台大醫院', 'no-known-interaction'),
            med('A11CC05', 'Vitamin D3', '維生素 D3', '1000IU', '每日一次', '營養補充', '馬偕醫院', 'no-known-interaction'),
            med('A11A', 'Multivitamin', '綜合維他命', '1錠', '每日一次', '營養補充', '台大醫院', 'unevaluable')
          ],
          reminders: [
            { time: '08:00', text: '服用阿斯匹靈、賴諾普利', completed: false },
            { time: '12:00', text: '服用二甲雙胍 (飯後)', completed: false },
            { time: '20:00', text: '服用華法林', completed: false }
          ]
        });
      case 'P001':
        return Object.assign({}, common, {
          profile: {
            id: 'P001', name: '張小泉', nationalId: 'B287654326',
            age: 68, gender: '女', nextAppointmentInDays: 5
          },
          stats: Object.assign({}, common.stats, { activeMeds: 3 }),
          medications: [
            med('A10BA02', 'Metformin', '二甲雙胍', '500mg', '每日兩次 (飯後)', '降血糖藥', '榮總醫院', 'no-known-interaction'),
            med('C09AA03', 'Lisinopril', '賴諾普利', '10mg', '每日一次 (早)', '降血壓藥', '台大醫院', 'no-known-interaction'),
            med('C10AA05', 'Atorvastatin', '阿托伐他汀', '20mg', '睡前一次', '降血脂藥', '馬偕醫院', 'no-known-interaction')
          ],
          reminders: [
            { time: '08:00', text: '服用賴諾普利', completed: false },
            { time: '12:00', text: '服用二甲雙胍 (飯後)', completed: false },
            { time: '22:00', text: '服用阿托伐他汀', completed: false }
          ]
        });
      case 'P002':
        return Object.assign({}, common, {
          profile: {
            id: 'P002', name: '李大維', nationalId: 'A145678903',
            age: 75, gender: '男', nextAppointmentInDays: 8
          },
          stats: Object.assign({}, common.stats, { activeMeds: 3 }),
          medications: [
            med('A10BA02', 'Metformin', '二甲雙胍', '500mg', '每日兩次 (飯後)', '降血糖藥', '榮總醫院', 'no-known-interaction'),
            med('C09AA03', 'Lisinopril', '賴諾普利', '10mg', '每日一次 (早)', '降血壓藥', '台大醫院', 'no-known-interaction'),
            med('C10AA05', 'Atorvastatin', '阿托伐他汀', '20mg', '睡前一次', '降血脂藥', '馬偕醫院', 'no-known-interaction')
          ],
          reminders: [
            { time: '08:00', text: '服用賴諾普利、阿托伐他汀', completed: false },
            { time: '12:00', text: '服用二甲雙胍 (飯後)', completed: false }
          ]
        });
      case 'P003':
        return Object.assign({}, common, {
          profile: {
            id: 'P003', name: '陳美花', nationalId: 'C209876541',
            age: 70, gender: '女', nextAppointmentInDays: 15
          },
          stats: Object.assign({}, common.stats, { activeMeds: 3 }),
          medications: [
            med('A10BA02', 'Metformin', '二甲雙胍', '500mg', '每日兩次 (飯後)', '降血糖藥', '榮總醫院', 'no-known-interaction'),
            med('C09AA03', 'Lisinopril', '賴諾普利', '10mg', '每日一次 (早)', '降血壓藥', '台大醫院', 'no-known-interaction'),
            med('C10AA05', 'Atorvastatin', '阿托伐他汀', '20mg', '睡前一次', '降血脂藥', '馬偕醫院', 'no-known-interaction')
          ],
          reminders: [
            { time: '08:00', text: '服用賴諾普利', completed: false },
            { time: '12:00', text: '服用二甲雙胍 (飯後)', completed: false },
            { time: '22:00', text: '服用阿托伐他汀', completed: false }
          ]
        });
      case 'P004':
        return Object.assign({}, common, {
          profile: {
            id: 'P004', name: '劉建國', nationalId: 'D112358131',
            age: 66, gender: '男', nextAppointmentInDays: 3
          },
          stats: Object.assign({}, common.stats, { activeMeds: 4 }),
          medications: [
            med('B01AA03', 'Warfarin', '華法林', '5mg', '每日一次 (晚)', '抗凝血劑', '台大醫院', 'risk'),
            med('B01AC06', 'Aspirin', '阿斯匹靈', '100mg', '每日一次 (早)', '非類固醇消炎藥', '長庚醫院', 'risk'),
            med('C01BD01', 'Amiodarone', '胺碘酮', '200mg', '每日一次', '抗心律不整藥', '成大醫院', 'risk'),
            med('A10BA02', 'Metformin', '二甲雙胍', '500mg', '每日兩次 (飯後)', '降血糖藥', '榮總醫院', 'no-known-interaction')
          ],
          ddiAlerts: [
            { id: 'B001', drugs: ['Warfarin', 'Aspirin'], severity: '極高風險',
              message: '同時服用華法林與阿斯匹靈會顯著增加胃腸道出血風險。',
              recommendation: '請諮詢李小美醫師是否需要調整抗血小板藥物劑量。' },
            { id: 'B002', drugs: ['Warfarin', 'Amiodarone'], severity: '高風險',
              message: '胺碘酮會顯著提升華法林血中濃度，易導致抗凝效果過強。',
              recommendation: '建議劑量減半，並密切監測 INR 凝血指標。' }
          ],
          reminders: [
            { time: '08:00', text: '服用阿斯匹靈', completed: false },
            { time: '12:00', text: '服用二甲雙胍 (飯後)', completed: false },
            { time: '20:00', text: '服用華法林、胺碘酮', completed: false }
          ]
        });
      default:
        throw new Error('不是展示帳號：' + username);
    }
  }

  function careCaseSeeds() {
    const now = Date.now();
    return [
      { patientId: 'P004', patientName: '劉建國', riskScore: 82,
        activatedAt: now, activatedDate: new Date().toLocaleDateString('zh-TW'),
        status: '處理中', assignee: '國泰核保員' },
      { patientId: 'patient01', patientName: '王大明', riskScore: 65,
        activatedAt: now, activatedDate: new Date().toLocaleDateString('zh-TW'),
        status: '已關懷', assignee: '國泰核保員' }
    ];
  }

  async function claimSeeds() {
    return [
      { customer: '王大明', amount: 'NT$ 1,200', description: '門診藥費理賠',
        status: '已核准', statusClass: 'text-turquoise bg-turquoise/10',
        progress: 100, submittedAt: Date.now(), time: new Date().toLocaleString('zh-TW') },
      { customer: '劉建國', amount: 'NT$ 3,400', description: '住院醫療理賠',
        status: '審核中', statusClass: 'text-yellow-600 bg-yellow-50',
        progress: 50, submittedAt: Date.now(), time: new Date().toLocaleString('zh-TW') }
    ];
  }

  async function policySeeds() {
    const specs = [
      { customer: '王大明', name: '安心醫療保險 (L2)', amount: 'NT$ 500,000' },
      { customer: '張小泉', name: '長照補充保險 (L1)', amount: 'NT$ 300,000' }
    ];
    const out = [];
    for (const s of specs) {
      out.push(Object.assign({}, s, {
        hash: await contentDigest([s.customer, s.name, s.amount]),
        createdAt: Date.now()
      }));
    }
    return out;
  }

  // ── 冷卻時間：讀取共用的重置狀態文件 ───────────────────────────────
  async function getState() {
    const [col, id] = STATE_DOC.split('/');
    const snap = await window.db.collection(col).doc(id).get();
    return snap.exists ? snap.data() : null;
  }

  async function canRun() {
    const state = await getState();
    if (!state || !state.lastResetAt) return { ok: true };
    const last = state.lastResetAt.toMillis ? state.lastResetAt.toMillis() : 0;
    const elapsed = Date.now() - last;
    if (elapsed >= COOLDOWN_MS) return { ok: true };
    return { ok: false, remainingMs: COOLDOWN_MS - elapsed };
  }

  // 依序執行多個 batch，而非塞進單一 batch——Firestore 單一 batch 上限
  // 500 個操作，聊天訊息數量不可預期（雖然展示情境下不會逼近上限，
  // 但寫成「不假設上限不會被碰到」比較誠實）。
  async function commitInChunks(ops, chunkSize) {
    for (let i = 0; i < ops.length; i += chunkSize) {
      const batch = window.db.batch();
      for (const op of ops.slice(i, i + chunkSize)) op(batch);
      await batch.commit();
    }
  }

  // ── 主流程 ──────────────────────────────────────────────────────────
  // actorUsername：呼叫者的 username，寫入重置狀態文件供事後追查「誰、
  // 何時重置過」——與 audit_logs 的具名精神一致，即使這裡沒有另外寫
  // audit_logs（重置本身不是臨床動作，不屬於該集合的記錄範圍）。
  async function run(actorUsername) {
    const gate = await canRun();
    if (!gate.ok) return { ok: false, reason: 'cooldown', remainingMs: gate.remainingMs };

    const summary = { patients: 0, careCases: 0, claims: 0, policies: 0,
      appointmentsCancelled: 0, appointmentCreated: false, scheduleSeeded: false,
      conversationsCleared: 0, warnings: [] };

    // 各區塊互相獨立、各自 try/catch：任一區塊失敗（例如規則尚未部署、
    // 網路中斷）不應讓已經成功的區塊也一併回報失敗。呼叫端據 warnings
    // 判斷本次重置是否完整，而非只看單一的 ok/fail。這與 db-service.js
    // 一貫「不吞失敗、讓呼叫端自己判斷嚴重度」的原則一致。

    // 1) 病患資料：整份覆寫（非 merge），確保訪客留下的欄位不會殘留
    try {
      for (const username of DEMO_PATIENTS) {
        await window.db.collection('patient_data').doc(username)
          .set(patientSeed(username));
        summary.patients++;
      }
    } catch (e) {
      summary.warnings.push('病患資料：' + (e.message || e));
    }

    // 2) care_cases / insurance_claims / insurance_policies：
    //    這三個集合僅 admin/insurance 可寫，且僅供展示用途（保單/理賠/
    //    關懷個案的核保端 Demo 沒有真實保戶），故整批清空重建，
    //    不需要逐筆比對白名單。
    try {
      const [cases, claims, policies] = await Promise.all([
        window.db.collection('care_cases').get(),
        window.db.collection('insurance_claims').get(),
        window.db.collection('insurance_policies').get()
      ]);
      const ops = [];
      cases.docs.forEach(d => ops.push(b => b.delete(d.ref)));
      claims.docs.forEach(d => ops.push(b => b.delete(d.ref)));
      policies.docs.forEach(d => ops.push(b => b.delete(d.ref)));
      const [newCases, newClaims, newPolicies] = await Promise.all([
        Promise.resolve(careCaseSeeds()), claimSeeds(), policySeeds()
      ]);
      newCases.forEach(rec => ops.push(b => b.set(window.db.collection('care_cases').doc(), rec)));
      newClaims.forEach(rec => ops.push(b => b.set(window.db.collection('insurance_claims').doc(), rec)));
      newPolicies.forEach(rec => ops.push(b => b.set(window.db.collection('insurance_policies').doc(), rec)));
      await commitInChunks(ops, 400);
      summary.careCases = newCases.length;
      summary.claims = newClaims.length;
      summary.policies = newPolicies.length;
    } catch (e) {
      summary.warnings.push('保單／理賠／關懷個案：' + (e.message || e));
    }

    // 3) appointments：不可刪除（firestore.rules 刻意禁止，見檔頭說明）。
    //    把白名單病患名下仍「進行中」的舊掛號改為 cancelled，
    //    再補一筆新的示範掛號，讓畫面有東西可看而不是空的。
    try {
      const snap = await window.db.collection('appointments')
        .where('patient', 'in', DEMO_PATIENTS).get();
      const ops = [];
      snap.docs.forEach(d => {
        const status = d.data().status;
        if (status !== 'cancelled' && status !== 'completed') {
          ops.push(b => b.update(d.ref, {
            status: 'cancelled',
            updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
          }));
          summary.appointmentsCancelled++;
        }
      });
      const scheduledAt = new Date();
      scheduledAt.setDate(scheduledAt.getDate() + 7);
      ops.push(b => b.set(window.db.collection('appointments').doc(), {
        patient: 'patient01', patientName: '王大明',
        doctor: DEMO_DOCTOR, doctorName: '李小美醫師',
        department: '一般內科',
        scheduledAt: window.firebase.firestore.Timestamp.fromDate(scheduledAt),
        status: 'booked',
        createdAt: window.firebase.firestore.FieldValue.serverTimestamp(),
        note: ''
      }));
      await commitInChunks(ops, 400);
      summary.appointmentCreated = true;
    } catch (e) {
      summary.warnings.push('掛號紀錄：' + (e.message || e));
    }

    // 3b) 示範醫師的門診班表。沒有這一份，病患端的醫師選單會是空的，
    //     掛號只剩下「以醫師帳號掛號」那條舊制路徑——評審打開就看不到
    //     叫號與預估時間這個功能。週一到週五各排早診與午診。
    //
    //     admin 可以寫任一位醫師的班表（見 firestore.rules 的 isAdmin 分支）；
    //     這裡刻意不設 exceptions，讓示範資料不會因為某天被停診而看起來壞掉。
    try {
      const weekly = {};
      [1, 2, 3, 4, 5].forEach(dow => {
        weekly[String(dow)] = {
          am: { start: '09:00', end: '12:00', capacity: 30 },
          pm: { start: '14:00', end: '17:00', capacity: 30 }
        };
      });
      await window.db.collection('doctor_schedules').doc(DEMO_DOCTOR).set({
        username: DEMO_DOCTOR,
        displayName: '李小美醫師',
        department: '一般內科',
        avgMinutes: 8,
        bookingWindowDays: 30,
        weekly,
        exceptions: {},
        updatedBy: DEMO_DOCTOR,
        updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
      });
      summary.scheduleSeeded = true;
    } catch (e) {
      summary.warnings.push('門診班表：' + (e.message || e));
    }

    // 4) 醫病對話：僅白名單帳號可被刪除（firestore.rules 的
    //    isDemoPatientUsername()）。逐一刪除訊息子集合，再刪對話文件本身。
    //    這條路徑依賴的規則例外若尚未部署會回 permission-denied，
    //    獨立 try/catch 讓其餘區塊不受影響。
    try {
      const ops = [];
      for (const username of DEMO_PATIENTS) {
        const convRef = window.db.collection('conversations').doc(username);
        const msgs = await convRef.collection('messages').get();
        if (msgs.empty) {
          const convSnap = await convRef.get();
          if (!convSnap.exists) continue;
        }
        msgs.docs.forEach(d => ops.push(b => b.delete(d.ref)));
        ops.push(b => b.delete(convRef));
        summary.conversationsCleared++;
      }
      if (ops.length) await commitInChunks(ops, 400);
    } catch (e) {
      summary.warnings.push('醫病對話：' + (e.message || e));
    }

    // 5) 冷卻時間狀態。即使前面有區塊失敗仍要更新——避免使用者在
    //    看到局部失敗後立刻重試，反而被冷卻時間卡住卻搞不清楚原因。
    try {
      const [col, id] = STATE_DOC.split('/');
      await window.db.collection(col).doc(id).set({
        lastResetAt: window.firebase.firestore.FieldValue.serverTimestamp(),
        resetBy: actorUsername || 'unknown'
      }, { merge: true });
    } catch (e) {
      summary.warnings.push('冷卻時間狀態未更新：' + (e.message || e));
    }

    return Object.assign({ ok: true }, summary);
  }

  return { DEMO_PATIENTS, canRun, run, getState };
})();
