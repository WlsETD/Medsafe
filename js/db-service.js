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

  // 保戶目錄改讀真實病患資料，讓新註冊的病患自動出現在核保員的名單裡
  async getAllPatients() {
    const snap = await window.db.collection('patient_data').get();
    return snap.docs.map(d => ({ username: d.id, ...d.data() }));
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
  async createUser(username, password, name, role) {
    const email = username.trim().toLowerCase() + '@medsafe.local';
    const cred = await window.secondaryAuth.createUserWithEmailAndPassword(email, password);
    const uid = cred.user.uid;
    await window.secondaryAuth.signOut();
    await window.db.collection('user_roles').doc(uid).set({ username, name, role, status: 'active' });
    await window.db.collection('users').doc(username).set({ uid, name, role, status: 'active' });
    return uid;
  }
};
