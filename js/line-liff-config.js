// LIFF App ID。這是公開資訊——會出現在 Rich Menu 連結、瀏覽器網址列、
// LINE 內建瀏覽器的位址列裡，本來就不是機密，比照 js/firebase-config.js
// 的 apiKey 處理方式，直接寫在前端。
//
// 空字串時 js/liff-bridge.js 會靜默略過整個 LIFF 登入流程，
// 一般帳號密碼登入完全不受影響。
window.LIFF_ID = '2011556856-q7GxQLhS';

// 家屬檢視專用的 LIFF App ID，指向 family.html（唯讀）而非 patient.html。
// 需要在 LINE Developers Console 另外註冊一個 LIFF App、Endpoint URL
// 設為 family.html?liff=1，可以掛在同一個既有的 LINE Login channel 底下
// （見 functions/src/config.js 的 FAMILY_LIFF_ID 說明）。
// 空字串時 family.html 會顯示「尚未開通」而不是硬要走一個開不了的 LIFF 流程。
window.FAMILY_LIFF_ID = '2011556856-U7sGX3qy';
