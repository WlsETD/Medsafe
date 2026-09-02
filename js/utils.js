window.utils = {
  // 狀態標籤對應樣式
  getStatusClass(status) {
    const map = {
      '完成': 'bg-success-light text-success-text',
      '進行中': 'bg-primary-light text-primary-dark',
      '待審核': 'bg-warning-light text-warning-text',
      '停用': 'bg-danger-light text-danger'
    };
    return map[status] || 'bg-gray-100 text-gray-600';
  },

  // 格式化日期
  formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  },

  // 格式化數字 (千分位)
  formatNumber(num) {
    return num ? num.toLocaleString('zh-TW') : '0';
  },

  // 格式化金額 (統一使用 NT$ 顯示，全站共用避免 $ / NT$ 混用)
  formatCurrency(num) {
    const n = Number(num) || 0;
    return `NT$ ${n.toLocaleString('zh-TW')}`;
  }
};

// 中華民國國民身分證統一編號／新式外來人口統一證號的格式與檢查碼驗證。
//
// 本函式只在使用者自己的瀏覽器中執行。號碼不會寫入 Firestore、不會進入任何
// 網路請求、不會出現在 URL 或 console，離開這個頁面即不復存在。
//
// 它能證明的事：「這是一組結構上合法的號碼」。
// 它不能證明的事：「這組號碼屬於眼前這個人」——真正的實名核驗需要串接
// 內政部或電信業者的認證服務，屬於規劃中項目，不應對使用者宣稱已具備。
//
// 為何不做「同一號碼是否已註冊」的查重：查重必須把號碼或其雜湊存進資料庫。
// 合法號碼僅約 5,200 萬組，而純前端系統的雜湊金鑰必然隨原始碼一併公開，
// 實測單執行緒 69 秒即可建出完整的「雜湊 → 號碼」對照表，雜湊等同明文；
// 且一個可被查詢的集合會形成「某人是否為本院病患」的查詢神諭，洩漏就醫事實。
// 在沒有伺服器端（Cloud Functions）的前提下，蒐集這項高敏感識別資料所增加的
// 風險高於其防止重複註冊的效益——何況任何人改填另一組合法號碼即可繞過查重。
// 這是個資法第 5 條比例原則下的取捨，不是偷懶。
window.validateNationalId = (function () {
  // 首碼英文字母對應的兩位數值。I、O、W、X、Y、Z 不依字母順序，是官方定義如此。
  const LETTER_VALUE = {
    A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34, J: 18, K: 19,
    L: 20, M: 21, N: 22, O: 35, P: 23, Q: 24, R: 25, S: 26, T: 27, U: 28, V: 29,
    W: 32, X: 30, Y: 31, Z: 33
  };

  // 第 2 碼：本國國民為 1（男）或 2（女）；2021 年起發放的新式外來人口統一證號為 8 或 9。
  // 納入 8、9 是必要的——把在台居留的外籍人士擋在醫療系統之外，
  // 會讓這個欄位本身變成就醫的障礙。兩者共用同一套檢查碼演算法。
  const PATTERN = /^[A-Z][1289][0-9]{8}$/;

  // 加權：首碼拆成的兩位數各為 1 與 9，其後 9 碼為 8,7,6,5,4,3,2,1,1
  //（最後一碼是檢查碼本身，權重亦為 1），總和能被 10 整除即通過。
  const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 1, 1];

  return function validateNationalId(raw) {
    const id = String(raw == null ? '' : raw).trim().toUpperCase();
    if (!id) return { valid: false, reason: 'empty' };
    if (!PATTERN.test(id)) return { valid: false, reason: 'format' };

    const letterValue = LETTER_VALUE[id[0]];
    const digits = id.slice(1).split('').map(Number);
    let sum = Math.floor(letterValue / 10) + (letterValue % 10) * 9;
    for (let i = 0; i < WEIGHTS.length; i++) sum += digits[i] * WEIGHTS[i];

    return sum % 10 === 0 ? { valid: true } : { valid: false, reason: 'checksum' };
  };
})();
