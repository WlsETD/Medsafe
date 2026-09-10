// 【經評估後決定不採用 Firestore 離線持久化（enablePersistence）】
// 啟用後 getUserRole() 在離線時會回傳快取的 user_roles 文件並「成功」，
// 於是一個已被管理員停用的帳號只要離線，就能拿舊快取通過 status === 'active' 檢查
// 並正常掛載頁面。Firestore 規則仍會擋掉所有實際資料讀取，但畫面會渲染出一個
// 「看起來還能用」的介面給一個已被停權的人，這與 auth.js 的驗證方向相反。
// 目前刻意保留「離線時 get() 直接 reject → 顯示可重試畫面」的行為。

const firebaseConfig = {
  apiKey: "AIzaSyCMPhyppaq4D3ba4yUUz-DmeGS9w8wgrN0",
  authDomain: "medsafe-554b7.firebaseapp.com",
  projectId: "medsafe-554b7",
  storageBucket: "medsafe-554b7.firebasestorage.app",
  messagingSenderId: "198938211918",
  appId: "1:198938211918:web:9d86ca5093a7e38fe9f51f"
};

firebase.initializeApp(firebaseConfig);
window.db = firebase.firestore();
window.auth = firebase.auth();

// Cloud Functions（LINE 整合用）。
//
// 【區域必須明寫】Functions 部署在 asia-east1——那是 Firestore 資料庫所在地，
// 而 Firestore 觸發器必須與資料庫同區，其餘 Function 便一併放在同區。
// 少了這個參數，SDK 會打到預設的 us-central1 並得到 404 not-found，
// 錯誤訊息不會提到區域，會看起來像「函式沒部署成功」。
//
// 只有載入了 firebase-functions-compat.js 的頁面（目前是 patient.html）
// 才有 firebase.app().functions；其餘頁面此處靜默略過，不影響原有功能。
window.functions = (typeof firebase.app().functions === 'function')
  ? firebase.app().functions('asia-east1')
  : null;

// 給管理員「新增帳號」使用的獨立 Auth instance，
// 避免 createUserWithEmailAndPassword 把目前登入的管理員自動切換登入成新帳號
window.secondaryAuth = firebase.initializeApp(firebaseConfig, 'Secondary').auth();
