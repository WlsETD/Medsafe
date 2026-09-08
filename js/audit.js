// 稽核軌跡（Phase 4 / 稽核報告 P1-5）
//
// 修復前：全專案搜尋不到任何稽核寫入。建立帳號、停用帳號、變更角色、修改 DDI 規則、
// 開立處方、覆蓋交互作用警示、變更系統設定——全部不留痕跡。
// 醫師端那個「處方稽核紀錄」面板顯示的是 mockData 裡的靜態假資料。
//
// 法規依據：《個人資料保護法施行細則》第 12 條第 2 項第 4 款要求建立稽核機制；
// 《醫療機構電子病歷製作及管理辦法》要求記錄存取軌跡。這是法定必要條件，不是加分項。
//
// ── 這一層能保證什麼、不能保證什麼（務必連同限制一起理解）──────────────
//
// 能保證（由 Firestore 規則強制，前端無法繞過）：
//   一、不可竄改——update 與 delete 一律拒絕，寫下去就改不掉、刪不了
//   二、不可冒名——actor 必須等於呼叫者自己的 username，且須與 Auth 簽發的
//       token.email 相符，無法把行為記到別人頭上
//   三、不可竄改時間——at 必須等於伺服器收到請求的時間，無法回填或造假時序
//
// 不能保證（必須誠實說明）：
//   無法保證每個動作都被記錄。記錄由前端主動寫入，惡意的呼叫端只要不呼叫就沒有記錄。
//   要達成「動作必然留痕」，必須由後端 trigger 在資料變更時自動寫入（列於 Phase 6）。
//   因此目前的稽核軌跡足以支撐臨床可追溯性與事後調查，但不足以對抗蓄意的隱匿。
//
// 把這個限制寫在這裡，是為了不讓任何人看到「有稽核軌跡」四個字就以為問題已經解決。

window.Audit = (function () {

  // 動作代碼採固定詞彙。若各處自行拼字串，日後就查不到——
  // 「override_ddi」與「ddi_override」會變成兩種永遠對不起來的記錄。
  const ACTIONS = {
    PRESCRIBE: 'prescribe',                     // 開立處方
    DDI_OVERRIDE: 'ddi_override',               // 覆蓋交互作用警示
    DDI_BLOCKED: 'ddi_blocked',                 // 因高風險而被系統攔截（未開立）
    PRESCRIBE_FAILED: 'prescribe_failed',       // 開立流程失敗（寫入未成功）
    USER_CREATE: 'user_create',
    USER_DISABLE: 'user_disable',
    USER_ROLE_CHANGE: 'user_role_change',
    DDI_RULE_CHANGE: 'ddi_rule_change',
    SETTINGS_CHANGE: 'settings_change',
    MAINTENANCE_TOGGLE: 'maintenance_toggle',
    // 緊急調閱：在沒有醫病關係的情況下取用病歷。
    // 這是系統中唯一允許自我授權的動作，因此也是最需要事後複查的一筆記錄。
    BREAK_GLASS: 'break_glass',
    // 查閱直接識別符（身分證字號）。醫師本來就有權查看，
    // 記錄的目的不是阻擋，而是讓事後能查出誰在什麼時候看了誰的證號。
    PII_VIEW: 'pii_view',
    // 櫃檯報到指派：醫護宣告「病患持證件到場」而建立照護關係。
    // 系統無法驗證證件是否確實被出示，因此記錄的是那句宣告本身。
    CARE_ASSIGN: 'care_assign',
    // 展示帳號資料重置（見 js/demo-reset.js）。記錄的意義與 break_glass
    // 同一類：這是一個刻意放寬給 admin 的特殊動作（含刪除白名單對話），
    // 事後留痕才知道誰、何時重置過。
    DEMO_RESET: 'demo_reset'
  };

  // 稽核記錄本身不得成為新的個資外洩管道。這裡只記「誰、何時、對誰、做了什麼」，
  // 不記病歷內容；藥名與嚴重度屬於該次決策的必要事實，予以保留。
  function sanitize(v, maxLen) {
    if (v == null) return null;
    const s = String(v);
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
  }

  return {
    ACTIONS: ACTIONS,

    // 寫入一筆稽核記錄。
    //
    // 【絕不吞掉失敗】回傳 { ok: true } 或 { ok: false, error }，由呼叫端決定嚴重度。
    // 對「覆蓋高風險警示」這類動作，稽核寫入失敗應視同整個操作失敗——
    // 一個無法被追溯的覆蓋，正是 P1-1 要消滅的東西。對次要動作則可僅提示。
    // 這個判斷屬於呼叫端的臨床情境，不該由本模組代為決定，故不在此處靜默處理。
    async log(action, target, detail) {
      const user = (typeof getVerifiedUser === 'function') ? getVerifiedUser() : null;
      if (!user || !user.username) {
        return { ok: false, error: new Error('尚未取得已驗證身分，不可寫入稽核記錄') };
      }
      if (!action || typeof action !== 'string') {
        return { ok: false, error: new Error('稽核記錄必須指明動作代碼') };
      }
      if (!window.db || !window.firebase) {
        return { ok: false, error: new Error('資料庫尚未初始化') };
      }
      try {
        await window.db.collection('audit_logs').add({
          actor: user.username,
          actorRole: user.role,
          actorName: sanitize(user.name, 64),
          action: action,
          target: sanitize(target, 128),
          detail: detail || null,
          // 必須是伺服器時間戳：Firestore 規則要求 at == request.time，
          // 用戶端時鐘寫進來的值一律會被拒絕，因此時序無法被偽造。
          at: window.firebase.firestore.FieldValue.serverTimestamp(),
          ua: sanitize(navigator.userAgent, 256)
        });
        return { ok: true };
      } catch (e) {
        console.error('[Audit] 寫入失敗：', action, e);
        return { ok: false, error: e };
      }
    },

    // 讀取稽核記錄（僅 admin 有權限，由 Firestore 規則把關）。
    // 失敗時同樣不吞——讀不到記錄與沒有記錄是兩回事，管理者必須能分辨。
    async recent(limit) {
      if (!window.db) return { ok: false, error: new Error('資料庫尚未初始化'), logs: [] };
      try {
        const snap = await window.db.collection('audit_logs')
          .orderBy('at', 'desc').limit(limit || 50).get();
        return { ok: true, logs: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
      } catch (e) {
        console.error('[Audit] 讀取失敗：', e);
        return { ok: false, error: e, logs: [] };
      }
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = window.Audit;
