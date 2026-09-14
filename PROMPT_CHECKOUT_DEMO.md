# 掛號結帳（純示範）— 開發 Prompt

**建立日期**：2026-09-13
**用途**：掛號流程加一個「結帳」步驟，示範用途，不接真實金流，不申請 LINE Pay 商家帳號。
**專案位置**：`D:\競賽\GCA\Source_Code\Security-main`
**正式站台**：https://medsafe-554b7.web.app

---

## 目標

掛號送出前多一個畫面：顯示掛號費金額，提供「線上付款（LINE Pay）」與「到場付款」兩個選項。
不論選哪個、不論有沒有真的完成付款動作，按下確認後掛號一律成功建立——這支只是讓 demo
影片跟截圖裡「有結帳這件事」，不是真的收費系統。

## 明確禁止事項（避免做過頭）

- **不要**申請 LINE Pay 商家帳號、不要串 LINE Pay Request/Confirm API、不要打任何 LINE Pay 的
  真實或 Sandbox 端點。這支功能完全在自己的前端跟 Firestore 裡跑完，不對外呼叫任何金流服務。
- **不要**新增真的退款、重複扣款防護、對帳這類金流才需要的機制——這些在真金流才有意義，
  示範用途做了也驗證不了什麼，純粹浪費時間。
- **不要**讓這個步驟卡住既有掛號流程的任何一條路徑（CLAUDE.md 提到的 A／B／C 三種
  `appointments` create 路徑、`appointment_locks`、`appointment_counters` 的交易寫入邏輯）。
  結帳只是掛號送出前多一個 UI 確認畫面，掛號本身的資料模型與規則完全不動。

## 建議做法

1. 開 feature branch（例如 `feat/booking-checkout-demo`），先讀 `CLAUDE.md` 關於
   「Outpatient schedules & queue-number booking」那一整段，搞懂 `appointments` 現有的
   A/B/C 三種 create 路徑與 `appointment_locks`／`appointment_counters` 的交易寫法，
   確保新增的 UI 步驟包在既有送出流程「之前」，不改動送出當下的交易邏輯本身。

2. 在 `patient.html` 現有的掛號表單（`activeView === 'appointments'` 那個區塊）送出按鈕前，
   插入一個確認畫面／彈出視窗：
   - 顯示掛號費金額（先寫死一個示範金額即可，例如 NT$150，不用真的做診別/醫師差異定價）
   - 兩個選項：「線上付款」「到場付款」（用 radio button 或兩個並排按鈕都可以）
   - 選「線上付款」時，按下確認可以加一小段**純視覺的模擬付款動畫**（例如兩秒的 loading
     圈，接一個「付款成功」勾勾），不真的呼叫任何外部服務——這段純粹是為了 demo 影片好看，
     跟後面資料怎麼寫完全無關
   - 不管選哪個，最後都呼叫既有的 `DbService.appointments.bookQueued()`（或現有的送出函式）
     正常建立掛號

3. 掛號文件（`appointments/{id}`）上加兩個**顯示用**欄位就好，不要再另外開一個交易集合：
   - `paymentMethod`：`'online'` 或 `'onsite'`
   - `paymentStatus`：選「線上付款」寫 `'paid-demo'`，選「到場付款」寫 `'pending-onsite'`——
     兩個值都刻意帶 `-demo`／`pending` 字樣，不要讓任何一個值看起來像是真的收到錢的確認碼，
     避免之後有人誤把這個欄位當成真實金流狀態使用
   - 這兩個欄位純粹是 `create` 時一次寫入、之後不需要被更新，不用另外開規則允許 update，
     沿用 `appointments` 現有 create 規則附加驗證這兩個欄位存在即可（值只能是上述列舉的
     字串，其餘一律拒絕——比照 CLAUDE.md 說的「rules 是唯一真正的存取控制邊界」原則，
     不要只在前端限制這兩個值)

4. 醫師端／管理端如果有列出掛號清單的畫面，付款方式跟狀態可以順手顯示出來（例如小標籤
   「已线上付款」「到場付款」），純顯示，不用加任何互動或篩選功能。

5. **不需要新增 Cloud Function，不需要動 `functions/` 目錄下任何檔案。** 這支功能完全是
   前端 UI + Firestore 規則的小擴充，跟 LINE Bot／LIFF 整個是分開的兩件事——它甚至不需要
   透過 LINE 才能觸發，一般網頁版掛號也會看到這個結帳畫面，這樣 LIFF 掛號頁面之後做完，
   直接繼承這個流程，不用重做一次。

## 驗收

- 補一組 `tests/firestore-rules.test.mjs` 的對照測試：驗證 `paymentMethod`／`paymentStatus`
  只能是允許的列舉值，其餘值一律拒絕；沒有補齊這兩個欄位的掛號建立會被拒絕的行為要跟
  既有 A/B/C 三條路徑的既有測試放在一起，不要漏改其中一條路徑就忘了補這兩個欄位的驗證。
- `npm run test:rules` 維持全數通過（目前基準包含既有規則測試）。
- 瀏覽器真機測試：走完一次「選線上付款 → 看到模擬付款動畫 → 掛號成功」與「選到場付款 →
  直接掛號成功」兩條路徑，並確認 Firestore 裡兩筆掛號文件的 `paymentMethod`／
  `paymentStatus` 值正確。

## 給投稿文案用的講法（如果評審問起）

「目前是示範環境，付款流程已規劃走 LINE Pay Checkout API（Request → 使用者確認 → Confirm
三段式），示範版本先驗證使用者流程與資料模型，正式上線前會另外申請 LINE Pay 商家資格並
接上 Sandbox 測試。」——誠實講清楚這是示範，不要讓畫面看起來像是已經真的能收費，這句話
比硬做出一個沒測過的真金流更安全。
