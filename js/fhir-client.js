// FHIR 伺服器連線層（Phase 5）
//
// 這個檔案解決三個彼此獨立的問題：
//
// 一、【沒有逾時】全專案 5 處 fetch 沒有任何一個設定逾時或中止機制。
//     目標是 hapi.fhir.org —— 一個全球共用的公開沙箱，時常緩慢或無回應。
//     瀏覽器的預設逾時可長達數分鐘，這段期間畫面上的「同步中…」會一直轉，
//     使用者除了重新整理沒有別的辦法。核心功能看起來就是壞的。
//
// 二、【Base URL 寫死】管理後台有一個 FHIR Base URL 欄位，值卻從未被使用——
//     三個端點各自硬寫 'https://hapi.fhir.org/baseR4'，改設定不會有任何效果。
//     這與 autoBlock 是同一類問題：一個看起來可以設定、實際上不起作用的設定，
//     比沒有這個設定更糟，因為它讓人以為已經設好了。
//
// 三、【失敗時無從得知能力是否存在】伺服器不可用時，使用者只看到一句「同步失敗」，
//     無從判斷是自己的網路問題、對方伺服器問題，還是這個功能根本沒做。
//     因此失敗結果一律帶回可讀的原因，並保留已產生的 FHIR 資源供檢視。
//
// ── 關於 API Key（刻意不實作，理由必須寫下來）────────────────────────
// 管理後台原本有一個「Access Key」欄位。它在本架構下**無法安全實作**：
// 純前端應用送出的每一個請求都由使用者的瀏覽器發出，任何金鑰都必須先送到瀏覽器，
// 因此對該使用者而言是可見的。把金鑰存進 admin_data 更糟——那份文件的規則是
// `allow read: if isActive()`，等於發給每一位登入者。
// 要對受保護的 FHIR 伺服器做認證存取，必須由後端代理持有憑證（列於 Phase 6）。
// 該欄位已從介面移除，而不是留著一個永遠不會生效的輸入框。
//
// ── 四、【警告燈綁錯了對象】（2026-09-03 發現並修正）──────────────────
// 原本的判斷是 isPublicSandbox()：用正規表示式比對網址是不是 hapi.fhir.org，
// 介面上所有「資料會外流」的警告都掛在它身上。
//
// 遷移到自架的 Cloud Run FHIR Server 之後，這個判斷回 false，於是警告全部消失——
// 但那台伺服器實測 `GET /fhir/Patient` 未帶任何憑證即回 HTTP 200，
// 讀寫依然對全世界開放。淨效果是「伺服器一樣全開，警告卻不見了」。
//
// 錯誤的形狀與稽核報告 P0-3、P0-4 完全相同：**判斷條件綁在一個代理指標上
// （網址長什麼樣），而不是綁在它真正要描述的那件事上（有沒有存取控制）。**
// 網址改變時，代理指標與事實就脫鉤了。
//
// 因此改為 isUnprotected()，依據兩件事：
//   1. hapi.fhir.org 恆為未受保護——這不是管理者能宣告的事
//   2. 其餘位址看管理端是否**明確宣告**已設定存取控制，且預設為「否」
// 預設為「否」是必要的：系統無法自行驗證對方有沒有存取控制，
// 而「不知道」不可以呈現為「安全」——那正是本專案從 P0-3 一路反對的事。

window.FhirClient = (function () {

  // 逾時 12 秒。公開沙箱的正常回應多在 2 秒內；超過這個時間，
  // 繼續等下去對使用者沒有意義，不如明確告知並讓他決定要不要重試。
  const TIMEOUT_MS = 12000;

  // 預設值。實際使用的位址以管理後台的設定為準（見 init）。
  const DEFAULT_BASE = 'https://hapi.fhir.org/baseR4';

  let _base = DEFAULT_BASE;
  let _fromSettings = false;
  // 管理端是否宣告「此伺服器已設定存取控制」。預設 false——
  // 沒有人宣告過，就等於沒有人確認過，不可當作已受保護。
  let _accessControlDeclared = false;

  // 只接受 https。除了避免混合內容被瀏覽器擋下，更實際的理由是：
  // 這條連線送的是病歷資料，用明文 http 傳輸等於沿路都看得到。
  function sanitizeBase(url) {
    const s = String(url || '').trim().replace(/\/+$/, '');
    if (!/^https:\/\/[^\s]+$/i.test(s)) return null;
    return s;
  }

  return {
    // 由各頁面在啟動時呼叫。讀不到設定時沿用預設值——
    // 這裡 fail-open 是合理的：讀不到設定就停用 FHIR 功能，
    // 會讓一個網路抖動變成功能消失，而這個功能本身不涉及存取控制。
    // 但實際使用的位址一律可由 baseUrl() 查得，介面上據實顯示。
    async init() {
      try {
        const st = await DbService.getSystemSettings();
        const clean = st ? sanitizeBase(st.fhirUrl) : null;
        if (clean) { _base = clean; _fromSettings = true; }
        // 讀取失敗時這個值維持 false，也就是維持「未受保護」的保守結論。
        _accessControlDeclared = !!(st && st.fhirAccessControlled);
      } catch (e) {
        console.error('[FhirClient] 設定讀取失敗，沿用預設位址：', e);
      }
      return _base;
    },

    baseUrl() { return _base; },
    isFromSettings() { return _fromSettings; },

    // 目前位址的主機名，供介面據實顯示，取代寫死的 'hapi.fhir.org'。
    host() {
      try { return new URL(_base).host; } catch (e) { return _base; }
    },

    // 是否指向 HL7 的公開沙箱。僅用於「這台伺服器尖峰時段很慢」這類
    // 針對該沙箱本身的說明，不再用來決定要不要顯示資料外流警告。
    isPublicSandbox() { return /(^|\/\/)hapi\.fhir\.org/i.test(_base); },

    // 這台伺服器是否**未受存取控制保護**（介面的資料外流警告掛在這裡）。
    //
    // 注意它問的不是「這是不是公開沙箱」，而是「有沒有人擋在門口」。
    // 兩者在遷移到自架伺服器時會分岔：網址不再是 hapi.fhir.org，
    // 但若沒設存取控制，資料一樣是全世界可讀寫的。
    //
    // hapi.fhir.org 恆為 true：那是 HL7 的公開沙箱，
    // 「已設定存取控制」不是任何管理者能對它宣告的事。
    isUnprotected() {
      if (this.isPublicSandbox()) return true;
      return !_accessControlDeclared;
    },

    // 管理端宣告過存取控制，但本連線層從不送出任何憑證（見檔頭 API Key 一節）。
    // 因此這個宣告是**operator 的具結**，不是系統驗證的結果——
    // 與病患摘要的 attestedBy 同一種處理：系統驗不了的事就標明是誰說的。
    accessControlIsDeclaredOnly() { return _accessControlDeclared; },

    // 統一的請求入口。回傳恆為結構化結果，不拋例外——
    // 呼叫端因此不會有「忘了 catch 而讓整個流程中斷」的路徑。
    //
    // reason 是給使用者看的句子，說明「發生什麼事」與「可以怎麼辦」，
    // 而不是把 HTTP 狀態碼直接丟到畫面上。
    async request(path, options) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const url = _base + (path.charAt(0) === '/' ? path : '/' + path);
      try {
        const res = await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
        let data = null;
        try { data = await res.json(); } catch (e) { /* 非 JSON 回應，data 保持 null */ }
        if (!res.ok) {
          return {
            ok: false, status: res.status, data: data,
            reason: 'FHIR 伺服器回應錯誤（HTTP ' + res.status + '）。'
                  + (res.status >= 500 ? '這是對方伺服器的問題，請稍後再試。' : '請確認伺服器位址與資源格式。')
          };
        }
        return { ok: true, status: res.status, data: data, reason: '' };
      } catch (e) {
        if (e && e.name === 'AbortError') {
          return {
            ok: false, timedOut: true, error: e,
            reason: 'FHIR 伺服器在 ' + (TIMEOUT_MS / 1000) + ' 秒內沒有回應，已中止本次連線。'
                  + (this.isPublicSandbox() ? '目前使用的是 HL7 公開測試伺服器，尖峰時段時常無回應。' : '')
          };
        }
        return {
          ok: false, error: e,
          reason: '無法連線至 FHIR 伺服器。請確認網路連線；若問題持續，可能是對方伺服器暫時停止服務。'
        };
      } finally {
        clearTimeout(timer);
      }
    },

    // 送出資源。resourceTypeOrPath 為空字串時代表送到 base（Bundle 交易）。
    async send(resourceTypeOrPath, body) {
      return this.request(resourceTypeOrPath ? '/' + resourceTypeOrPath : '', {
        method: 'POST',
        headers: { 'Content-Type': 'application/fhir+json' },
        body: JSON.stringify(body)
      });
    },

    async search(path) {
      return this.request(path, { headers: { 'Accept': 'application/fhir+json' } });
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = window.FhirClient;
