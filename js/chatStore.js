// 醫病對話（稽核報告 P1-4）
//
// 修復前：全部對話存在 localStorage['medsafe_chat_*']，明文、無加密、永不過期；
// listConversations() 掃描整個 localStorage，醫師端瀏覽器因此累積所有病患的對話內容；
// 通知的 content 欄位還帶著「病患姓名：訊息全文」一併落地。
// 更根本的問題是：localStorage 只在同一台電腦內有效，所謂「即時通訊」實際上
// 醫師與病患必須共用同一台機器——那不是通訊，是同機兩個分頁互相寫檔。
//
// 醫病溝通紀錄在法律上屬於病歷的一部分。存在瀏覽器 localStorage 既不符合
// 《醫療機構電子病歷製作及管理辦法》的保存要求，也會隨清除快取而永久遺失。
//
// 現改為 Firestore：conversations/{病患}/messages/{訊息}，由安全規則限定
// 只有該對話的參與者（病患本人與其主治醫師）能讀寫，訊息寫入後不可修改或刪除。
//
// ── 為什麼保留同步的 API ──────────────────────────────────────────────
// getMessages() 等函式維持同步回傳，由本模組內部以 Firestore 的即時監聽維護快取。
// 這讓 25 處呼叫端不必全部改寫成 async，降低這次改動引入新錯誤的機會。
// 代價是呼叫端讀到的是「最後一次同步的狀態」——對聊天介面而言這正是想要的行為。
//
// ── localStorage 現在還留什麼 ────────────────────────────────────────
// 只留「最後讀取時間戳」與「通知的 id／時間／是否緊急」——全部是數字與旗標，
// 不含任何訊息內容、姓名或病歷資訊。未讀狀態本來就該是每台裝置各自記錄的偏好。

window.chatStore = {
  _cache: {},        // patientId -> messages[]（由 onSnapshot 維護）
  _meta: {},         // patientId -> 對話的中繼資料
  _cbs: [],          // 變更回呼
  _unsubs: {},       // patientId -> Firestore 取消訂閱函式
  _convUnsub: null,  // 對話清單的取消訂閱函式
  _me: null,         // { username, role }
  _ready: false,

  // ── 初始化：必須在使用其他函式前呼叫 ──────────────────────────
  // role 決定訂閱範圍：病患只訂閱自己那一串；醫師訂閱所有把自己列為參與者的對話。
  // 這個範圍限制不只是效率考量——安全規則要求查詢自帶 participants 條件，
  // 少了它整個查詢會被拒絕，醫師無法列舉他人的對話。
  init(role, username) {
    // 可重入：病患端在取得主治醫師帳號後會再呼叫一次（participants 必須在
    // 建立當下就寫對）。若不先解除前一批監聽，_convUnsub 會被覆寫而洩漏，
    // 舊的監聽將持續運作到頁面卸載為止，且兩批快照會互相覆蓋快取。
    this.dispose();
    this._me = { username: username, role: role };
    if (!window.db) return Promise.resolve(false);
    const col = window.db.collection('conversations');
    const q = role === 'patient'
      ? col.where('participants', 'array-contains', username)
      : col.where('participants', 'array-contains', username);
    return new Promise(resolve => {
      let settled = false;
      this._convUnsub = q.onSnapshot(snap => {
        const seen = new Set();
        snap.docs.forEach(d => {
          const pid = d.id;
          seen.add(pid);
          this._meta[pid] = d.data();
          if (!this._unsubs[pid]) this._subscribeMessages(pid);
        });
        // 已不再參與的對話要取消訂閱並清出快取，避免撤銷權限後仍留在記憶體
        for (const pid of Object.keys(this._unsubs)) {
          if (!seen.has(pid)) this._unsubscribeMessages(pid);
        }
        this._ready = true;
        this._emit();
        if (!settled) { settled = true; resolve(true); }
      }, err => {
        console.error('[chatStore] 對話清單訂閱失敗：', err);
        this._ready = false;
        if (!settled) { settled = true; resolve(false); }
      });
    });
  },

  _subscribeMessages(pid) {
    this._unsubs[pid] = window.db.collection('conversations').doc(pid)
      .collection('messages').orderBy('at', 'asc')
      .onSnapshot(snap => {
        this._cache[pid] = snap.docs.map(d => {
          const m = d.data();
          return {
            id: d.id,
            from: m.from,
            text: m.text,
            // 伺服器時間戳在本機回寫（latency compensation）期間可能尚未產生，
            // 此時退回目前時間，讓排序與未讀計算不會因為 null 而錯亂
            ts: m.at && m.at.toMillis ? m.at.toMillis() : Date.now()
          };
        });
        this._emit();
      }, err => console.error('[chatStore] 訊息訂閱失敗：', pid, err));
  },

  _unsubscribeMessages(pid) {
    if (this._unsubs[pid]) { this._unsubs[pid](); delete this._unsubs[pid]; }
    delete this._cache[pid];
    delete this._meta[pid];
  },

  _emit() { this._cbs.forEach(cb => { try { cb(); } catch (e) { console.error(e); } }); },

  // 登出時務必呼叫：解除所有監聽並清空記憶體中的對話內容。
  // 不做這件事，切換帳號後前一位使用者的訊息仍留在同一個 JS 環境裡。
  dispose() {
    if (this._convUnsub) { this._convUnsub(); this._convUnsub = null; }
    Object.keys(this._unsubs).forEach(pid => this._unsubscribeMessages(pid));
    this._cache = {}; this._meta = {}; this._me = null; this._ready = false;
  },

  isReady() { return this._ready; },

  // ── 訊息 ────────────────────────────────────────────────────
  getMessages(patientId) { return this._cache[patientId] || []; },

  // 送出訊息。回傳 { ok } —— 失敗不可靜默，病患或醫師必須知道訊息沒送出去。
  async addMessage(patientId, from, text, doctorUsername) {
    if (!window.db || !this._me) return { ok: false, error: new Error('對話尚未初始化') };
    const convRef = window.db.collection('conversations').doc(patientId);
    try {
      // 對話文件可能尚未建立（第一則訊息）。participants 決定了誰讀得到這串對話，
      // 因此必須在建立當下就寫對——事後補寫等於讓對話有一段時間無人可讀或人人可讀。
      if (!this._meta[patientId]) {
        const doc = await convRef.get();
        if (!doc.exists) {
          const parts = [patientId];
          if (doctorUsername) parts.push(doctorUsername);
          await convRef.set({
            patient: patientId,
            doctor: doctorUsername || null,
            participants: parts,
            createdAt: window.firebase.firestore.FieldValue.serverTimestamp()
          });
        }
      }
      await convRef.collection('messages').add({
        from: from,
        text: String(text == null ? '' : text),
        at: window.firebase.firestore.FieldValue.serverTimestamp()
      });
      return { ok: true };
    } catch (e) {
      console.error('[chatStore] 訊息送出失敗：', e);
      return { ok: false, error: e };
    }
  },

  // 掃出所有對話串，供醫師端訊息中心列出。
  // 修復前這裡掃的是整個 localStorage，因此醫師端會看到「這台電腦上曾經登入過的
  // 所有病患」的對話——包含已經不是自己病患的人。現在來源是 Firestore 查詢，
  // 範圍由安全規則決定，掃不到不該看的對話。
  listConversations() {
    const out = [];
    for (const pid of Object.keys(this._cache)) {
      const messages = this._cache[pid];
      if (!messages || !messages.length) continue;
      out.push({ patientId: pid, messages: messages, last: messages[messages.length - 1] });
    }
    return out.sort((a, b) => b.last.ts - a.last.ts);
  },

  // ── 未讀追蹤 ────────────────────────────────────────────────
  // 「最後讀取時間」是純數字，且本來就該是每台裝置各自的狀態，故留在 localStorage。
  _seenKey(role, patientId) { return 'medsafe_seen_' + role + '_' + patientId; },
  getSeen(role, patientId) {
    try { return Number(localStorage.getItem(this._seenKey(role, patientId)) || 0); }
    catch (e) { return 0; }
  },
  markChatRead(role, patientId) {
    const list = this.getMessages(patientId);
    const last = list.length ? list[list.length - 1].ts : Date.now();
    try {
      localStorage.setItem(this._seenKey(role, patientId),
        String(Math.max(last, this.getSeen(role, patientId))));
    } catch (e) { /* 隱私模式下寫不進去，未讀數會退化為每次重新計算，不影響安全 */ }
  },
  getUnreadCount(role, patientId) {
    const seen = this.getSeen(role, patientId);
    return this.getMessages(patientId)
      .filter(m => m.from !== role && m.from !== 'system' && m.ts > seen).length;
  },

  // ── 通知 ────────────────────────────────────────────────────
  // 【只存不含內容的中繼資料】修復前這裡存的是
  //   { title: '病患新訊息', content: '王大明：我最近頭暈…' }
  // ——病患姓名與訊息全文就這樣落在醫師電腦的 localStorage 裡，永不過期。
  // 現在只留 patientId、時間、是否緊急；姓名與預覽由呼叫端從對話快取即時取得，
  // 對話快取的來源是 Firestore，權限由安全規則把關，且登出即隨頁面消失。
  _notifKey(role) { return 'medsafe_notif_' + role; },
  getNotifications(role) {
    try { return JSON.parse(localStorage.getItem(this._notifKey(role)) || '[]'); }
    catch (e) { return []; }
  },
  notify(role, notif) {
    const list = this.getNotifications(role);
    list.unshift({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      read: false,
      // 白名單：只收這三個欄位，其餘一律丟棄。
      // 用白名單而非黑名單，是因為日後新增欄位時，忘記過濾的預設結果會是
      // 「不寫入」而不是「寫入了不該寫的東西」。
      patientId: notif && notif.patientId ? String(notif.patientId) : null,
      critical: !!(notif && notif.critical),
      ts: Date.now()
    });
    try { localStorage.setItem(this._notifKey(role), JSON.stringify(list.slice(0, 30))); }
    catch (e) { /* 寫不進去時僅損失通知，不影響對話本身 */ }
  },
  markAllRead(role) {
    const list = this.getNotifications(role).map(n => ({ ...n, read: true }));
    try { localStorage.setItem(this._notifKey(role), JSON.stringify(list)); } catch (e) {}
  },
  markRead(role, id) {
    const list = this.getNotifications(role).map(n => n.id === id ? { ...n, read: true } : n);
    try { localStorage.setItem(this._notifKey(role), JSON.stringify(list)); } catch (e) {}
  },

  // ── 變更通知 ────────────────────────────────────────────────
  // 原本監聽 localStorage 的 storage 事件，只在同一台電腦的不同分頁間作用。
  // 現在來源是 Firestore 的即時監聽，跨裝置、跨網路都會收到。
  onChange(cb) {
    this._cbs.push(cb);
    return () => { this._cbs = this._cbs.filter(f => f !== cb); };
  }
};
