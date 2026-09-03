// 本地頭像產生器：以姓名首字 + 背景色畫成 SVG data URI。
// 取代原本的 ui-avatars.com——那會把病患真實姓名放進第三方網址，
// 姓名因此留存於該服務的存取日誌，屬於未經告知的個資境外傳輸。
window.localAvatar = function (name, bg, fg) {
  const raw = String(name == null ? '' : name).trim();
  const ch = raw ? Array.from(raw)[0] : '?';
  const esc = c => c.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 顏色只接受色碼字面值：目前呼叫端都傳硬編碼值，但若日後有人接上使用者可控的資料，
  // 未過濾的屬性值會讓 SVG 屬性被跳脫。白名單比事後補救便宜。
  const color = (v, fallback) => (/^#[0-9a-fA-F]{3,8}$/.test(String(v || '')) ? v : fallback);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">'
    + '<rect width="96" height="96" fill="' + color(bg, '#24A15D') + '"/>'
    + '<text x="50%" y="50%" dy=".35em" text-anchor="middle" fill="' + color(fg, '#ffffff') + '"'
    + ' font-family="system-ui,-apple-system,Segoe UI,Noto Sans TC,sans-serif"'
    + ' font-size="44" font-weight="700">' + esc(ch) + '</text></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
};

window.DbService = {

  // --- FHIR 化名 ---
  // hapi.fhir.org 是 HL7 的公開沙箱：全球可讀寫、無存取控制、資料無法確保刪除。
  // 送出前以化名取代真實姓名與精確出生日期。
  //
  // 化名為「隨機產生後存入 patient_data.fhirPseudonym」，而非由 username 推導。
  // 這一點是關鍵：若用雜湊推導，演算法會隨前端原始碼一併公開，且 username 命名空間極小，
  // 任何人都能離線重建「化名 → 真實病患」的完整對照表，那樣的化名等於沒有作用。
  // 改為隨機值之後，對照表成為一份受 Firestore 規則保護的資料，符合化名的定義
  //（額外資訊須分開保存並施以技術措施）。純前端無法靠加 salt 解決——salt 同樣會被發佈。
  //
  // 仍須注意：藥品名稱與劑量以明文上傳，數種處方藥的組合本身即為準識別碼，
  // 因此本功能僅為「移除直接識別符」，不可對外宣稱為去識別化或匿名化。
  fhirDeid: {
    NAMESPACE: 'urn:medsafe:demo-subject',

    _randomId() {
      const rnd = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID().replace(/-/g, '')
        : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      return 'DEMO-' + rnd.slice(0, 12).toUpperCase();
    },

    // 取得（或初次建立）某病患的化名。同一病患每次同步都取回同一組值，
    // 條件式建立（ifNoneExist）才不會在公開伺服器上堆出重複資源。
    //
    // create:false 供唯讀情境使用（例如核保端查核）：
    // 核保員在規則上沒有 patient_data 的寫入權，若讓一個唯讀查核動作去鑄造化名，
    // 對尚未同步過的保戶必然 permission-denied，畫面會顯示成「查詢失敗」而誤導使用者。
    // 語意上也不該由核保端在病患的臨床文件裡寫入新識別碼。
    async getOrCreate(username, opts) {
      const allowCreate = !opts || opts.create !== false;
      const ref = window.db.collection('patient_data').doc(username);
      const snap = await ref.get();
      const existing = snap.exists && snap.data().fhirPseudonym;
      if (existing) return existing;
      if (!allowCreate) return null;
      const value = this._randomId();
      await ref.set({ fhirPseudonym: value }, { merge: true });
      return value;
    },

    displayName(pseudonymId) {
      return 'MedSafe 展示個案 ' + pseudonymId;
    },

    // 出生日期只送出模糊化的年份（FHIR date 允許僅 YYYY），且以 5 年為級距，
    // 避免精確生日成為準識別碼。年齡無效時回傳 undefined，不送出 "NaN-01-01"
    blurredBirthYear(age) {
      const n = Number(age);
      if (!Number.isFinite(n) || n <= 0 || n > 120) return undefined;
      const year = new Date().getFullYear() - Math.round(n);
      return String(Math.floor(year / 5) * 5);
    },

    // FHIR administrative-gender 有 male|female|other|unknown 四值，
    // 不可把所有非「男」一律歸為 female
    gender(value) {
      if (value === '男' || value === 'male') return 'male';
      if (value === '女' || value === 'female') return 'female';
      return 'unknown';
    },

    identifier(pseudonymId) {
      return { system: this.NAMESPACE, value: pseudonymId };
    }
  },

  // --- Safety Score Computation ---
  // 回傳 null 代表「無法評分」，呼叫端必須顯示「尚無足夠資料」而非任何數字。
  //
  // 為何空的 ddiAlerts 也回傳 null：系統目前沒有任何流程會自動計算並寫入 ddiAlerts
  // （addMedicationToPatient 只寫 medications），因此空陣列的真正含意是
  // 「從未做過交互作用評估」，而不是「已確認無交互作用」。
  // 若把未評估當成滿分，等於對病患與核保端主動製造錯誤的安全感——
  // 這與 fail-open 是同一種錯誤，只是換到了分數上。
  computeSafetyScore(medications, ddiAlerts) {
    if (!medications || medications.length === 0) return null;
    if (!Array.isArray(ddiAlerts) || ddiAlerts.length === 0) return null;

    let score = 100;
    for (const alert of ddiAlerts) {
      if (alert.severity === '極高風險') score -= 35;
      else if (alert.severity === '高風險') score -= 20;
      else score -= 8;
    }
    if (medications.length >= 5) score -= 10;
    return Math.max(0, score);
  },

  // 供 UI 區分「無法評分」的兩種原因，以顯示精確的說明文字
  safetyScoreStatus(medications, ddiAlerts) {
    if (!medications || medications.length === 0) return 'no-medications';
    if (!Array.isArray(ddiAlerts) || ddiAlerts.length === 0) return 'not-assessed';
    return 'scored';
  },

  // --- Auth ---
  // user_roles/{uid} 是給 Firestore 安全規則判斷身分用的索引，
  // 由 request.auth.uid 直接查詢，只有本人（或建立當下的管理員）能讀寫
  async getUserRole(uid) {
    const snap = await window.db.collection('user_roles').doc(uid).get();
    return snap.exists ? snap.data() : null;
  },

  // 自助註冊只能開 patient 角色的帳號（規則也會擋住其他角色），用主要的 window.auth
  // 建立帳號，讓使用者註冊後直接以該身分登入
  async registerPatient(username, password, name) {
    const email = username.trim().toLowerCase() + '@medsafe.local';
    const cred = await window.auth.createUserWithEmailAndPassword(email, password);
    const uid = cred.user.uid;
    try {
      await window.db.collection('user_roles').doc(uid).set({ username, name, role: 'patient', status: 'active' });
      await window.db.collection('users').doc(username).set({ uid, name, role: 'patient', status: 'active' });
      await window.db.collection('patient_data').doc(username).set({
        profile: {
          id: username, name, age: null, gender: '',
          healthSummary: '尚無用藥紀錄，請於回診時請醫師建立您的用藥檔案。',
          nextAppointment: ''
        },
        stats: { safetyScore: null, activeMeds: 0, aiChecksToday: 0, lastSync: '尚未同步' },
        medications: [],
        ddiAlerts: [],
        aiInsights: [],
        reminders: [],
        // 目前系統只有一位醫師，新註冊病患先預設指派給她；之後管理員可在後台改指派其他醫師
        assignedDoctor: 'doctor',
        assignedDoctorName: '李小美醫師'
      });
    } catch (e) {
      // users/{username} 已被其他人註冊走時，上面的寫入會被規則擋下（視為 update 而非 create）
      await cred.user.delete().catch(() => {});
      throw e;
    }
    return { username, role: 'patient', name };
  },

  // --- Admin ---
  async getAdminData() {
    const snap = await window.db.collection('admin_data').doc('main').get();
    return snap.exists ? snap.data() : null;
  },

  // --- Maintenance Mode ---
  async getMaintenanceMode() {
    const snap = await window.db.collection('admin_data').doc('main').get();
    return snap.exists ? (snap.data().maintenanceMode || false) : false;
  },

  async setMaintenanceMode(enabled) {
    await window.db.collection('admin_data').doc('main').set({ maintenanceMode: enabled }, { merge: true });
  },

  // 系統設置卡（FHIR URL、AI 敏感度門檻等），與 maintenanceMode 分開存但同一份文件，
  // 避免每次重整頁面後管理員的設定又被 mockData 預設值蓋掉
  async getSystemSettings() {
    const snap = await window.db.collection('admin_data').doc('main').get();
    return snap.exists ? (snap.data().systemSettings || null) : null;
  },

  async saveSystemSettings(settings) {
    await window.db.collection('admin_data').doc('main').set({ systemSettings: settings }, { merge: true });
  },

  // --- Doctor ---
  async getDoctorData() {
    const snap = await window.db.collection('doctor_data').doc('main').get();
    return snap.exists ? snap.data() : null;
  },

  // --- Patient ---
  async getPatientData(username) {
    const snap = await window.db.collection('patient_data').doc(username).get();
    return snap.exists ? snap.data() : null;
  },

  async updateReminders(username, remindersArray) {
    await window.db.collection('patient_data').doc(username).update({
      reminders: remindersArray
    });
  },

  // ── 用藥回報：逐日記錄 ────────────────────────────────────────────────
  //
  // 【為什麼不能沿用 reminders[].completed】
  // 原本勾選是直接把 completed 翻面存回 reminders，而系統沒有任何地方會重置它。
  // 因此那個布林值的實際語意是「這位病患曾在某個不明時點勾過這一格」——
  // 沒有日期、沒有歷史，明天打開還是勾著的。
  //
  // 病患端只看今天，這個缺陷看起來無害；但一旦要讓醫師看見遵從狀況，
  // 它就會變成「拿一個沒有意義的數字做臨床判斷」。改為逐日記錄之後，
  // 「每天重置」是新的一天沒有記錄的自然結果，不需要排程去清空任何東西——
  // 而且過去的資料被保留下來，醫師才有趨勢可看。
  //
  // 【每日記錄是自足的】
  // 每一天連同當天的排程內容一起存（time/text/total），而不是只存索引。
  // 醫師日後調整用藥排程時，舊記錄仍然描述得出「那天要吃的是什麼」；
  // 若只存索引，改一次排程就會讓所有歷史記錄指向錯誤的藥。
  adherence: {
    KEEP_DAYS: 30,

    // 用當地日期，不可用 toISOString().slice(0,10)——那是 UTC。
    // 在 UTC+8，早上 8 點以前勾的藥會被記進前一天，
    // 於是「今天」永遠顯示未回報，而昨天莫名其妙多了一筆。
    dayKey(d) {
      const t = d || new Date();
      const p = (n) => String(n).padStart(2, '0');
      return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
    },

    // 一則提醒在當天的識別。時間是排程的自然鍵，但同一天可能有兩則同時間的提醒，
    // 因此併用內容一起當鍵。
    slotKey(reminder) {
      return (reminder.time || '') + '|' + (reminder.text || '');
    },

    async record(username, dayKey, dayRecord) {
      const ref = window.db.collection('patient_data').doc(username);
      const snap = await ref.get();
      // 與 addMedicationToPatient 同樣的處理（P1-2）：查無病歷時回報事實，
      // 不要正常返回讓呼叫端以為已經寫入
      if (!snap.exists) return { persisted: false, reason: 'no-record' };
      const log = Object.assign({}, snap.data().adherenceLog || {});
      log[dayKey] = dayRecord;
      // 只保留最近 KEEP_DAYS 天。Firestore 單一文件有 1MB 上限，
      // 一份無限成長的每日記錄最終會讓整份病歷寫不進去——
      // 屆時連開藥與交互作用警示的寫入都會一起失敗，
      // 而失敗的原因會非常難查。
      const kept = {};
      for (const k of Object.keys(log).sort().reverse().slice(0, this.KEEP_DAYS)) kept[k] = log[k];
      await ref.update({ adherenceLog: kept });
      return { persisted: true };
    }
  },

  // 【回傳寫入結果，不再靜默假裝成功】（稽核報告 P1-2）
  //
  // 原本查無病歷時是一句 `if (!snap.exists) return;`——函式正常返回，呼叫端
  // 無從分辨「已寫入病歷」與「根本沒有這份病歷」。醫師看到的是「開立成功」，
  // 而病歷裡什麼都沒有；下次交互作用偵測時這個藥不存在，等同於偵測失效。
  //
  // 現在一律回傳 { persisted, reason }，由呼叫端據實告知醫師。
  // 真正的錯誤（權限不足、網路失敗、被安全規則拒絕）仍然往上拋，不在此處吞掉。
  async addMedicationToPatient(username, medication) {
    const ref = window.db.collection('patient_data').doc(username);
    const snap = await ref.get();
    if (!snap.exists) return { persisted: false, reason: 'no-record' };
    const meds = snap.data().medications || [];
    meds.push(medication);
    // 注意：此更新會被 Firestore 規則檢查——新增的用藥必須攜帶 safetyCheck，
    // 結論為 risk 時還必須帶覆蓋理由。缺少時這裡會拋出 permission-denied，
    // 那是正確行為，不可在此處捕捉後降級處理。
    await ref.update({ medications: meds });
    return { persisted: true };
  },

  // 病患目前指派的醫師（用查詢代替寫死名單），讓 demo 資料跟真實註冊的病患走同一套邏輯
  async getPatientsByDoctor(doctorUsername) {
    const snap = await window.db.collection('patient_data').where('assignedDoctor', '==', doctorUsername).get();
    return snap.docs.map(d => ({ username: d.id, ...d.data() }));
  },

  // ── 掛號（醫病關係的來源）────────────────────────────────────────────
  //
  // 見 firestore.rules 的 appointments 一節：掛號這個動作本身就是授權事件。
  // 醫師的病患清單由此產生，而不是由 patient_data.assignedDoctor 這個靜態欄位決定。
  appointments: {
    // 掛號狀態。'booked' 已預約、'arrived' 已報到、'finished' 已完診、'cancelled' 已取消。
    // 只有 booked 與 arrived 算「進行中的就診」，也就是醫師清單要顯示的對象。
    ACTIVE: ['booked', 'arrived'],

    // 照護關係的有效期。掛號給予的存取權必須有時間上限——
    // 一份永久有效的授權在個資法下與未取得授權無異。
    // 90 天足以涵蓋回診與追蹤，又不至於讓一次就診換來無限期的病歷存取權。
    RELATION_DAYS: 90,

    // 規則層無法查詢集合，因此另寫一份以 {病患}__{醫師} 為 ID 的關係文件，
    // 讓 hasActiveCareRelation() 能 O(1) 定位（見 firestore.rules 的說明）。
    async _grantRelation(patient, doctor) {
      const id = patient + '__' + doctor;
      const ref = window.db.collection('care_relations').doc(id);
      const expires = new Date();
      expires.setDate(expires.getDate() + this.RELATION_DAYS);
      const snap = await ref.get();
      if (snap.exists) {
        // 重新掛號等於續期。規則允許病患本人改 status/expiresAt。
        await ref.update({
          status: 'active',
          expiresAt: window.firebase.firestore.Timestamp.fromDate(expires),
          updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
        });
      } else {
        await ref.set({
          patient, doctor, status: 'active',
          grantedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
          expiresAt: window.firebase.firestore.Timestamp.fromDate(expires)
        });
      }
    },

    async _revokeRelation(patient, doctor) {
      await window.db.collection('care_relations').doc(patient + '__' + doctor).update({
        status: 'revoked',
        updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
      });
    },

    async create({ patient, patientName, doctor, doctorName, department, scheduledAt, note }) {
      const ref = await window.db.collection('appointments').add({
        patient, patientName: patientName || patient,
        doctor, doctorName: doctorName || doctor,
        department: department || '一般內科',
        scheduledAt: window.firebase.firestore.Timestamp.fromDate(new Date(scheduledAt)),
        status: 'booked',
        // 規則要求等於伺服器時間，前端無法回填或造假時序
        createdAt: window.firebase.firestore.FieldValue.serverTimestamp(),
        note: note || ''
      });
      // 掛號本身不會讓醫師看得到病歷——規則查的是照護關係文件。
      // 順序上先建掛號再授予關係：反過來的話，關係文件寫成功而掛號失敗時，
      // 會出現「醫師讀得到病歷，但系統中沒有任何就診紀錄可以解釋為什麼」。
      //
      // 兩次寫入不具原子性（Firestore 的 batch 無法混用 add 的自動 ID）。
      // 授予失敗時掛號已存在但醫師看不到——失效方向是「看不到」，
      // 而非「不該看卻看得到」，這是可接受的方向。錯誤仍往上拋，
      // 由呼叫端據實告知，不可靜默當作成功。
      await this._grantRelation(patient, doctor);
      return ref.id;
    },

    // 醫師端：只查指向自己的掛號。
    // 刻意不在查詢中串 where(status) + orderBy(scheduledAt)——那需要複合索引，
    // 而索引未建立時查詢會直接失敗。資料量小，篩選與排序在前端做即可。
    async byDoctor(doctorUsername) {
      const snap = await window.db.collection('appointments')
        .where('doctor', '==', doctorUsername).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },

    async byPatient(patientUsername) {
      const snap = await window.db.collection('appointments')
        .where('patient', '==', patientUsername).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },

    async setStatus(id, status) {
      await window.db.collection('appointments').doc(id).update({
        status,
        updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
      });
    },

    // 取消掛號，並在「與該醫師已無其他進行中的掛號」時一併撤銷照護關係。
    //
    // 【為什麼要先確認沒有其他掛號】
    // 同一位病患對同一位醫師可能有多筆掛號（回診、不同科別）。
    // 取消其中一筆就撤銷關係，會讓醫師在其餘尚未就診的預約上失去病歷存取權——
    // 病患只是改了一次時間，主治醫師卻打不開病歷了。
    async cancel(appointment) {
      const { id, patient, doctor } = appointment;
      await this.setStatus(id, 'cancelled');
      const remaining = (await this.byPatient(patient)).filter(a =>
        a.id !== id && a.doctor === doctor && this.ACTIVE.indexOf(a.status) !== -1);
      if (remaining.length) return { relationRevoked: false, remaining: remaining.length };
      await this._revokeRelation(patient, doctor);
      return { relationRevoked: true, remaining: 0 };
    }
  },

  // 醫師的病患清單：由進行中的掛號決定，而非 assignedDoctor 靜態欄位。
  //
  // 【為什麼要逐筆讀病歷而不是一次查詢】
  // 掛號集合只有 username，病歷在另一個集合。Firestore 沒有 join，
  // 因此必須逐筆取回。同一位病患可能有多筆掛號，先去重再讀，
  // 否則同一份病歷會被讀取多次，且清單上會出現重複的人。
  //
  // 讀取失敗的那一筆不可靜默略過——那會讓醫師的清單少一位病患，
  // 而少了誰完全看不出來。改為回報，由呼叫端決定如何呈現。
  async getPatientsByAppointment(doctorUsername) {
    const appts = await this.appointments.byDoctor(doctorUsername);
    const active = appts.filter(a => this.appointments.ACTIVE.indexOf(a.status) !== -1);
    const usernames = [];
    for (const a of active) {
      if (a.patient && usernames.indexOf(a.patient) === -1) usernames.push(a.patient);
    }
    const patients = [], failed = [];
    for (const u of usernames) {
      try {
        const snap = await window.db.collection('patient_data').doc(u).get();
        if (snap.exists) {
          patients.push({ username: u, ...snap.data() });
        } else {
          // 有掛號但查無病歷：資料不一致，必須讓呼叫端知道
          failed.push({ username: u, reason: 'no-record' });
        }
      } catch (e) {
        failed.push({ username: u, reason: (e && e.code) || 'error' });
      }
    }
    return { patients, failed, appointments: active };
  },

  async assignDoctorToPatient(username, doctorUsername, doctorName) {
    await window.db.collection('patient_data').doc(username).set(
      { assignedDoctor: doctorUsername, assignedDoctorName: doctorName },
      { merge: true }
    );
  },

  // --- Insurance ---
  async getInsuranceData() {
    const snap = await window.db.collection('insurance_data').doc('main').get();
    return snap.exists ? snap.data() : null;
  },

  async addCareCase(record) {
    await window.db.collection('care_cases').add(record);
  },

  async getCareCases() {
    const snap = await window.db.collection('care_cases').orderBy('activatedAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async updateCareCaseStatus(id, status) {
    await window.db.collection('care_cases').doc(id).update({ status });
  },

  // ── 病患同意機制（稽核報告 P1-6）───────────────────────────────────────
  //
  // 原本這裡有一個 getAllPatients()，直接把 patient_data 整個集合撈給核保端，
  // 核保員因此讀得到每一位病患的完整用藥史與交互作用警示。該函式已移除，
  // 安全規則也同步撤銷了保險角色對 patient_data 的讀取權。
  //
  // 取而代之的模型：
  //   一、病患主動授予同意 → consents/{病患}__{保險端}，有期限、可撤回
  //   二、病患發布核保摘要 → patient_summaries/{病患}，只含最小必要欄位
  //   三、核保端先查自己拿到哪些同意，再據此逐一取得摘要
  //
  // 這個順序很重要：核保端無法列舉「所有摘要」，只能從自己手上的同意書出發。
  // 沒有同意就連對方存不存在都問不到。

  // 核保所需的最小欄位。刻意不含藥名、劑量、開立醫院、提醒、對話等內容——
  // 核保要的是風險指標，不是病歷。年齡改為級距，避免以生日反推身分。
  buildUnderwritingSummary(username, patientDoc) {
    const meds = (patientDoc && patientDoc.medications) || [];
    const alerts = (patientDoc && patientDoc.ddiAlerts) || [];
    const profile = (patientDoc && patientDoc.profile) || {};
    const age = Number(profile.age);
    const band = !age || isNaN(age) ? null
      : (age < 40 ? '40 歲以下' : age < 65 ? '40–64 歲' : age < 75 ? '65–74 歲' : '75 歲以上');
    return {
      username: username,
      displayName: profile.name || username,
      ageBand: band,
      medicationCount: meds.length,
      alertCount: alerts.length,
      safetyScore: this.computeSafetyScore(meds, alerts),
      scoreStatus: this.safetyScoreStatus(meds, alerts)
    };
  },

  // 病患發布自己的核保摘要。attestedBy/attestedAt 由規則強制為本人與伺服器時間，
  // 讓核保端看得出這是「病患自述」而非「系統已驗證」的資料。
  async publishUnderwritingSummary(username, patientDoc) {
    const summary = this.buildUnderwritingSummary(username, patientDoc);
    summary.attestedBy = username;
    summary.attestedAt = window.firebase.firestore.FieldValue.serverTimestamp();
    await window.db.collection('patient_summaries').doc(username).set(summary);
    return summary;
  },

  // 授予同意。有效期限為必填——一份永久有效的同意書在個資法下形同未取得同意。
  async grantConsent(patientUsername, insurerUsername, days) {
    const expires = new Date();
    expires.setDate(expires.getDate() + (days || 90));
    await window.db.collection('consents')
      .doc(patientUsername + '__' + insurerUsername)
      .set({
        patient: patientUsername,
        insurer: insurerUsername,
        scope: 'underwriting-summary',
        grantedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
        expiresAt: window.firebase.firestore.Timestamp.fromDate(expires),
        revokedAt: null
      });
  },

  // 撤回同意。不刪除文件——同意與撤回的歷程本身就是需要保存的證據。
  async revokeConsent(patientUsername, insurerUsername) {
    await window.db.collection('consents')
      .doc(patientUsername + '__' + insurerUsername)
      .update({ revokedAt: window.firebase.firestore.FieldValue.serverTimestamp() });
  },

  // 病患查看自己給出的所有同意
  async getMyConsents(patientUsername) {
    const snap = await window.db.collection('consents')
      .where('patient', '==', patientUsername).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  // 核保端：先查自己拿到哪些同意，再逐一取得對應的摘要。
  // where(insurer == 自己) 不只是效率考量——安全規則要求查詢自帶此條件，
  // 少了它整個查詢會被拒絕，核保端無法列舉他人的同意書。
  async getConsentedSummaries(insurerUsername) {
    const snap = await window.db.collection('consents')
      .where('insurer', '==', insurerUsername).get();
    const now = Date.now();
    const valid = snap.docs.map(d => d.data()).filter(c =>
      !c.revokedAt && c.expiresAt && c.expiresAt.toMillis() > now);
    const out = [];
    for (const c of valid) {
      // 逐份取得。同意已失效者在上方就被濾掉，不會發出請求；
      // 若規則仍拒絕（例如剛好在此刻過期），該筆略過而非讓整批失敗。
      try {
        const doc = await window.db.collection('patient_summaries').doc(c.patient).get();
        if (doc.exists) out.push({ ...doc.data(), consentExpiresAt: c.expiresAt });
      } catch (e) {
        console.warn('核保摘要讀取被拒或失敗：', c.patient, e);
      }
    }
    return out;
  },

  // --- Insurance Claims ---
  async getClaims() {
    const snap = await window.db.collection('insurance_claims').orderBy('submittedAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async submitClaim(record) {
    const ref = await window.db.collection('insurance_claims').add(record);
    return ref.id;
  },

  async updateClaimStatus(id, status, progress) {
    await window.db.collection('insurance_claims').doc(id).update({ status, progress });
  },

  // --- Insurance Policies ---
  async getPolicies() {
    const snap = await window.db.collection('insurance_policies').orderBy('createdAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async addPolicy(record) {
    const ref = await window.db.collection('insurance_policies').add(record);
    return ref.id;
  },

  // --- Shared ---
  async getGraphData() {
    const snap = await window.db.collection('graph_data').doc('main').get();
    return snap.exists ? snap.data() : null;
  },

  // --- DDI Rules ---
  async getDdiRules() {
    const snap = await window.db.collection('ddi_rules').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async addDdiRule(rule) {
    const ref = await window.db.collection('ddi_rules').add(rule);
    return ref.id;
  },

  async deleteDdiRule(id) {
    await window.db.collection('ddi_rules').doc(id).delete();
  },

  // --- User Management ---
  async getAllUsers() {
    const snap = await window.db.collection('users').get();
    return snap.docs.map(d => ({ username: d.id, ...d.data() }));
  },

  // 變更「目前登入者自己」的密碼。
  // Firebase 要求變更密碼前必須是近期登入，故先用舊密碼重新驗證一次；
  // 這同時也擋掉「電腦沒鎖被路過的人改密碼」的情境。
  //
  // 注意：純前端無法代改「他人」的密碼——那需要 Admin SDK（Cloud Functions 等後端）。
  // 因此後台不提供替他人重設密碼的按鈕，以免做出一個按了沒效果的假功能。
  async changeOwnPassword(currentPassword, newPassword) {
    const user = window.auth.currentUser;
    if (!user) throw new Error('尚未登入');
    const cred = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
    await user.reauthenticateWithCredential(cred);
    await user.updatePassword(newPassword);
  },

  // 用獨立的 secondaryAuth 建立 Firebase Auth 帳號，不影響目前登入的管理員 session
  //
  // 【原子性】（對抗性稽核 H-15）Auth 帳號與兩份 Firestore 文件必須一起成立。
  // 原本三個寫入各自獨立且沒有 rollback：只要後面任一步失敗，就留下一個孤兒 Auth 帳號——
  // email 被永久佔用（重建會得到 already-in-use），卻又登不進系統（user_roles 不存在），
  // 只能進 Firebase Console 手動刪除。自助註冊的 registerPatient 早就有回收邏輯，
  // 管理端建帳卻漏了這段。
  //
  // signOut 也必須移到寫入之後：一旦登出，cred.user 就失去憑證，
  // 回收用的 delete() 會以 requires-recent-login 失敗，rollback 形同虛設。
  // （Firestore 寫入走的是管理員的 window.db，與 secondaryAuth 無關，移動順序不影響權限。）
  async createUser(username, password, name, role) {
    const email = username.trim().toLowerCase() + '@medsafe.local';
    const cred = await window.secondaryAuth.createUserWithEmailAndPassword(email, password);
    const uid = cred.user.uid;
    try {
      const batch = window.db.batch();
      batch.set(window.db.collection('user_roles').doc(uid), { username, name, role, status: 'active' });
      batch.set(window.db.collection('users').doc(username), { uid, name, role, status: 'active' });
      await batch.commit();
    } catch (e) {
      try { await cred.user.delete(); } catch (_) { /* 回收失敗只能靠 Console，但錯誤仍要往上拋 */ }
      try { await window.secondaryAuth.signOut(); } catch (_) {}
      throw e;
    }
    await window.secondaryAuth.signOut();
    return uid;
  },

  // ── 角色與狀態變更：必須橫跨兩份文件且不可各自為政 ──────────────────────
  // （對抗性稽核 H-13、H-16）
  //
  // users/{username} 只供後台列表顯示；user_roles/{uid} 才是安全規則唯一採信的身分索引
  // （見 firestore.rules 的 profile()）。兩者分開 update 會產生最危險的一種不一致：
  // 前一個成功、後一個失敗時，列表顯示「已停用」，規則卻仍然放行——
  // 帳號看似被停權，實際保有完整權限。用 batch 讓兩份文件同生共死。
  //
  // 沒有 uid 就寫不到 user_roles，而規則只看 user_roles，此時變更對權限毫無效果。
  // 這種情況一律回報 { ok: false }，絕不可靜默視為成功——那正是 P1-2 修過的錯誤形狀。
  async setUserStatus(username, uid, status) {
    if (!uid) return { ok: false, reason: 'no-uid' };
    const batch = window.db.batch();
    batch.update(window.db.collection('users').doc(username), { status });
    batch.update(window.db.collection('user_roles').doc(uid), { status });
    await batch.commit();
    return { ok: true };
  },

  // 角色變更原本完全沒有落地——只改了 Vue 記憶體中的列表，重新整理即回復原狀，
  // 系統卻照樣寫下一筆 USER_ROLE_CHANGE 稽核記錄。
  // 稽核軌跡記載一件從未發生的事，比沒有稽核更危險：事後調查會據此做出錯誤結論。
  async setUserRole(username, uid, role) {
    if (!uid) return { ok: false, reason: 'no-uid' };
    const batch = window.db.batch();
    batch.update(window.db.collection('users').doc(username), { role });
    batch.update(window.db.collection('user_roles').doc(uid), { role });
    await batch.commit();
    return { ok: true };
  }
};
