# LIFF 掛號（完成「線上預約」格）— 開發 Prompt

**建立日期**：2026-09-13
**用途**：讓 Rich Menu 六宮格裡「線上預約」那格從「還在開發中」變成真的能用。
**專案位置**：`D:\競賽\GCA\Source_Code\Security-main`
**正式站台**：https://medsafe-554b7.web.app

---

## 先讀這個，你可能不用新建頁面

`LINE_DEVELOPMENT_PLAN.md` 原本寫的規劃是「新頁面 `liff-appointment.html`」，但實際看
`functions/src/richmenu.js` 的 `buildAreas()` 跟 `functions/src/webhook.js` 的
`bookingReply()`，兩處已經把「線上預約」這格的連結寫成：

```
https://liff.line.me/{LIFF_ID}?view=appointments
```

LIFF 的行為是：`https://liff.line.me/{id}` 這個短網址會被 LINE 解析回你在 LINE Developers
Console 註冊的 **Endpoint URL**，並把額外帶的 query string 接到後面。這個 LIFF App 的
Endpoint URL 在建立時設的是 `https://medsafe-554b7.web.app/patient.html?liff=1`（見
`LINE_DEVELOPMENT_PLAN.md` Phase 0 的建立步驟）。也就是說使用者實際打開的會是：

```
patient.html?liff=1&view=appointments
```

換句話說，**不需要新建一個頁面**，只要讓 `patient.html` 認得 `view=appointments` 這個
query string，LIFF 登入成功後直接跳到掛號畫面（也就是你已經做完結帳按鈕的那個既有區塊）
就完成了。這比原計畫的「新頁面、複用 `DbService.appointments`」省事很多——因為根本是同一
份 `patient.html`，`DbService.appointments` 本來就已經在用。

開工前務必先實際打開 `patient.html` 確認目前 `activeView`（或等義的頁籤狀態變數）是怎麼
命名、怎麼切換的，不要憑這份 prompt 的猜測就動手——命名以你讀到的程式碼為準。

---

## 目標

1. `bootLiff()`（`js/liff-bridge.js`）成功換發身分、`signInWithCustomToken` 完成之後，
   `patient.html` 要檢查網址上的 `view` 參數：
   - `view=appointments` → 直接切到既有的掛號表單區塊（就是你剛加了付款按鈕的那個）
   - 沒有這個參數，或值不是白名單裡的東西 → 維持原本預設行為（藥箱／首頁），不要因為
     一個未知的 `view` 值就白屏或報錯
2. **首次註冊流程也要接上這個參數。** `bootLiff()` 失敗且 `reason === 'failed-precondition'`
   時會走 `renderLiffRegister()` 那個註冊表單（見 `js/liff-bridge.js` 檔頭說明）；註冊完成、
   `liffRegisterPatient()` 拿到 Custom Token 登入成功後，同樣要檢查 `view=appointments` 並
   跳轉——不然「長輩第一次用，從 Rich Menu 點線上預約，結果被丟去填註冊表單，填完卻回到
   藥箱畫面」，這個體驗斷點比完全不做這個功能更糟。
3. 掛號表單本身（含你剛做完的付款選擇按鈕）不用改動任何邏輯，只是要確認在 LIFF 的
   webview（比一般手機瀏覽器再窄一些、頂部有 LINE 自己的標題列）裡版面不會跑掉——這是
   純 CSS／RWD 檢查，不是功能開發。

## 明確不要做的事

- **不要新建 `liff-appointment.html`**，理由見上方「先讀這個」。如果你發現實際程式碼跟
  這份 prompt 描述的架構對不上（例如 LIFF 的 Endpoint URL 設定跟這裡寫的不一樣），先停下
  來跟使用者確認，不要自己另外生一個新頁面出來繞過去。
- **不要動 `firestore.rules` 或 `appointments`／`appointment_locks`／
  `appointment_counters` 的任何交易邏輯**——這支功能純粹是「LIFF 登入後導到哪個畫面」的
  前端路由問題，掛號本身的資料寫入路徑完全不變。
- **不要重做綁定或身分驗證邏輯**——`bootLiff()`／`liffRegisterPatient()` 已經是實測過的
  完整流程（P0 已完成，見 `LINE_DEVELOPMENT_PLAN.md`），這支功能只在它成功「之後」多加
  一個畫面路由判斷，不要碰驗證流程本身。

## 驗收

- 手機 LINE 實測完整路徑：
  - [ ] 已綁定帳號：Rich Menu 點「線上預約」→ 直接開啟 `patient.html` 並落在掛號畫面
        （不是藥箱／首頁），掛號表單含付款選擇按鈕正常顯示
  - [ ] 未綁定帳號：Rich Menu 點「線上預約」→ 看到註冊表單 → 填完送出 → 直接落在掛號畫面，
        不是藥箱／首頁
  - [ ] 從 Rich Menu 點「藥箱」（或完整藥箱按鈕，沒帶 `view=appointments`）→ 行為跟現在完全
        一樣，沒有因為這次改動受影響
- 若專案有既有的 `tests/line-webhook.test.mjs`／LIFF 相關測試，補一組驗證
  `bookingReply()`／`buildAreas()` 產生的網址仍然正確帶有 `?view=appointments`（防止之後
  有人改動網址組法時，前端的判斷邏輯跟後端產生的網址悄悄對不上）。
- `npm test` 整體維持全數通過。
- 用瀏覽器窄版寬度（模擬 LIFF webview）檢查掛號表單版面，含付款按鈕，沒有跑版或被截斷。

## 完成後回頭要做的一件事

`LINE_DEVELOPMENT_PLAN.md` 的「Phase 2/3（依賴 Phase 0，尚未實作）」那個表格，把「LIFF
掛號」那一列的說明從「新頁面 `liff-appointment.html`」更新成實際做法（`view=appointments`
query string 路由），並把它從「尚未實作」移到已完成清單，跟「圖文選單擴充」那行一樣——
避免之後有人（包含你自己）照著舊的、已經不準的規劃文件又去重工一次。
