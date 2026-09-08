# LINE Bot 用藥提醒 — 架構規劃

**狀態**：設計定案，等待下方「你需要提供 / 決定的事項」確認後開始實作。
**建立日期**：2026-09-08

## 為什麼需要這份文件

MedSafe（GCA 金源獎投稿）第二優先待辦事項之一是「LINE Bot 提醒」——長輩不太會開網頁但會用 LINE，用意是讓用藥提醒能透過 LINE 推播送達病患（或未來的家屬）。

原本 2026-09-06 曾規劃過一版架構（`2026-09-06.md`），但該檔案因含內部維運資訊已從版控與本機磁碟移除（`firebase.json` 的 hosting ignore 清單裡還留著檔名，git history 裡也查不到，本機也已找不到聲稱存在的備份），只留下 `04_Security_Audit/0908.md` 裡轉述的一句線索：「曾規劃過 Cloud Function 代理的架構，可部分沿用其『Firebase ID Token 驗證』的思路」。**這份文件是重新設計的一版，取代舊稿，且是從頭設計，沒有更多舊稿內容可沿用。**

**關鍵限制**：這個專案目前是純靜態前端（Vue3 CDN + Tailwind CDN，無 build step）＋ Firebase Auth/Firestore，存取控制完全靠 `firestore.rules`（見 `CLAUDE.md`）。沒有任何伺服器端程式碼：`package.json` 沒有 `firebase-functions`/`firebase-admin` 依賴，`firebase.json` 沒有 `functions` 區塊，repo 裡沒有 `functions/` 目錄。CLAUDE.md 已明文記錄「純靜態前端無法保管密鑰」這條原則（FHIR 那段就是因為這樣才把自架代理伺服器整個砍掉）。LINE Messaging API 的 **Channel Access Token 是機密**，不能出現在前端程式碼裡，所以 LINE Bot 這個功能**必然需要新增本專案第一個伺服器端元件（Cloud Functions）**——這是架構上的分水嶺，不是單純加幾支 JS。

---

## 現有可沿用的資料模型（已確認）

### 用藥提醒儲存在哪裡

單一文件 `patient_data/{username}`（跟病歷、用藥清單、DDI 警示同一份文件），沒有子集合：

- `reminders`：陣列，`{ time: "08:00", text: "藥名（可能多個藥合併，用、分隔）", completed: false }`。`completed` 是舊欄位，**目前已不是「今天吃了沒」的依據**（改讀 `adherenceLog`）。讀寫透過 `js/db-service.js` 的 `DbService.updateReminders()` / `DbService.addReminderEntries()`。
- `adherenceLog`：map，key 是**本地時區**日期字串 `YYYY-MM-DD`（刻意不用 `toISOString()`，避免 UTC/UTC+8 位移），value 是當天快照 `{ total, schedule:[{time,text}], taken:[{time,text,at}] }`，只保留最近 30 天（`KEEP_DAYS`，避免超過 Firestore 1MB 文件上限）。
- `DbService.adherence.slotKey(reminder)` = `time + '|' + text`：一個提醒「時段」的識別碼（因為同一時間可能有多筆提醒）。
- `DbService.adherence.dayKey()`：用本地時鐘算出的日期字串。**LINE 推播 Function 如果要判斷「這個時段今天推播過了沒」，必須在伺服器端重現同一套本地時區邏輯**，否則會和前端的「今天」定義對不上。

### `patient_data` 的讀取權限（firestore.rules）

`isAdmin() || isOwnUsername(username) || isAssignedDoctorOf()（舊制）|| hasActiveCareRelation(username) || hasActiveBreakGlass(username)`。目前**沒有任何「家屬/多人共同查看」機制**——只有病患本人、被指派/有效照護關係的醫師、緊急破窗的醫師、管理員。這也是「家屬共照模式」（第二優先另一項）目前完全空白、需要新資料模型的原因；LINE 綁定先只做「病患本人」，之後若要開放家屬綁定，屬於共照模式的範圍，不在這次工作內。

### 可沿用的既有慣例（沒有直接可用的「邀請碼/連結碼」系統，但有兩個值得模仿的形狀）

1. **`{a}__{b}` 複合 ID + exists()/get() 查表**（`care_relations/{patient}__{doctor}`、`break_glass/{patient}__{doctor}`）——因為 Security Rules 不能查詢集合，只能查已知路徑。
2. **`patient_index/{nationalId}` 的 get-only、禁止 list 的精確查表**（`firestore.rules` 明確把 `get` 和 `list` 分開授權，避免枚舉/瀏覽）＋「有名有姓、伺服器時間戳、有效期限」的 accountable 授權文件（`care_relations` 的 `basis:'id-presented'` 那條路徑，來自「無 HIS」流程，git commit `05f14ef`）。

這次新增的 `line_link_codes`／`line_bindings` 會照這兩個既有慣例的形狀設計（見下）。

---

## 架構設計

### 元件總覽

```
病患瀏覽器 (patient.html，已用 Firebase Auth 登入)
   │  1. 呼叫 Function 產生短效綁定碼
   ▼
Firestore: line_link_codes/{code}   { username, expiresAt, used:false }
   │
   │  2. 病患在 LINE 加官方帳號好友，傳送該綁定碼
   ▼
LINE 官方帳號（Messaging API channel）
   │  3. webhook 事件（訊息事件）
   ▼
Cloud Function: lineWebhook (HTTPS)
   - 驗證 x-line-signature（用 Channel Secret，防偽造請求）
   - 查 line_link_codes/{code}，未過期/未用過
     → 寫入 line_bindings/{username} { lineUserId, linkedAt, active:true }
     → 標記該碼 used:true（碼本身不刪除，留稽核軌跡）
     → 回覆 LINE 訊息「綁定成功」
   │
   ▼
Cloud Function: lineReminderPush（觸發方式見下方「範圍」）
   - 用 Firebase Admin SDK 讀 patient_data/{username}.reminders
     （Admin SDK 本來就不受 firestore.rules 管，這是刻意的信任邊界，
     會在 CLAUDE.md 補一段說明，避免以後被誤判成漏洞）
   - 依 line_bindings/{username} 找出 lineUserId
   - 呼叫 LINE Messaging API 的 push endpoint 送出提醒訊息
```

### 兩個新 Firestore collection

- **`line_link_codes/{code}`**：`{ username, expiresAt, used }`。病患自己建立（規則：只能建立屬於自己 username 的碼、`expiresAt` 必須是伺服器時間戳＋短效期，例如 10 分鐘）。前端不能自己讀別人的碼（否則變成可猜測/枚舉的授權漏洞，比照 `patient_index` 的 get-only、無 list 精神）。Function（Admin SDK）核銷。
- **`line_bindings/{username}`**：`{ lineUserId, linkedAt, active }`。只有 Cloud Function（Admin SDK）能寫。病患自己可以「讀」自己的綁定狀態（前端顯示「已綁定 LINE」用）。解除綁定走 Function（設 `active:false`，不整筆刪除，呼應本專案「病歷證據不可竄改」的一貫設計哲學，且未來若真的誤判/需要稽核不會斷了線索）。

兩個 collection 的規則變更都要照專案既有規矩，補 `tests/firestore-rules.test.mjs` 對照測試並跑 `npm run test:rules`。

### 密鑰管理

Channel Secret / Channel Access Token 用 `firebase functions:secrets:set` 存進 Secret Manager，不進 git、不進前端。

### 推播觸發方式 — 兩個範圍層級，待你決定

- **展示等級（建議，時間壓力下優先）**：不做 Cloud Scheduler 定時輪詢，改成「事件觸發」＋「手動測試按鈕」：
  - 醫師/病患新增或修改今日用藥提醒時，直接呼叫一個 callable Function 立即推播一次「提醒已更新」。
  - `patient.html` 提供「傳送測試提醒」按鈕（callable Function），可以在展示影片裡直接演示「按下去、手機 LINE 馬上收到」，比等排程觸發更適合錄影，也大幅降低展示期間出錯的風險（提交後系統會鎖定、不可修改）。
  - 不做「到點才推播」的精準鬧鐘式提醒，也不做「未回報自動推播提醒」——這兩者都需要 Cloud Scheduler + 每天/每時觸發 + 判斷「今天此時段是否已推播過」的防重複邏輯（要用上面 `slotKey`/`dayKey` 的本地時區邏輯）+ 失敗重試，工程量與除錯成本明顯較高。
- **生產等級**：加 Cloud Scheduler（例如每 15 分鐘觸發一次 `lineReminderPush`），掃描所有病患的 `reminders[].time` 是否落在觸發窗內且今天尚未推播/尚未完成，逐一推播；需要額外的防重複、重試、時區處理邏輯。

---

## 你需要提供 / 決定的事項

1. **LINE Messaging API channel**：你有 LINE Developers 帳號並建立好 Messaging API channel 了嗎？需要 Channel ID、Channel Secret、Channel Access Token（長期）。如果還沒有，這是免費的，但帳號本身必須由你（用你的 LINE 帳號）去建立，我無法代辦；需要的話我可以之後指引申請步驟。

2. **Firebase 專案方案**：Cloud Functions（以及若選生產等級還會用到 Cloud Scheduler）需要 Firebase **Blaze（隨用隨付）方案**，目前免費額度通常足夠這種展示規模的用量，但需要掛信用卡。專案先前為了降低攻擊面/成本，把自架 FHIR 服務整個砍掉——所以這裡明確跟你確認：目前是否已是 Blaze 方案？是否願意升級並接受新增這類雲端資源？

3. **範圍選擇**：展示等級 vs 生產等級（見上）。建議展示等級——優先確保能穩定錄進 3 分鐘展示影片，且提交後系統會鎖定、範圍越小出錯風險越低。最終由你定。

4. **綁定對象**：先做「病患本人綁定 LINE」（本文件預設方案），還是要一併考慮「家屬綁定病患的 LINE 提醒」？後者跟尚未開始的「家屬共照模式」（第二優先另一項）有介面重疊，且目前系統完全沒有多人查看同一病患的授權機制，會需要一併設計新的 Firestore 資料模型，工程量明顯更大，不建議這次一起做。

5. **LINE 官方帳號的品牌**：顯示名稱/大頭貼，投稿影片會露出，建議先想好。

---

## 實作步驟（待上述事項確認後）

1. `firebase init functions`（Node.js 2nd gen）建立 `functions/` 目錄，`.gitignore`／`firebase.json` 補對應設定。
2. `firebase functions:secrets:set LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN`。
3. 新增 `line_link_codes`、`line_bindings` 到 `firestore.rules`，補 `tests/firestore-rules.test.mjs` 對照測試，跑 `npm run test:rules`。
4. 實作 `lineWebhook`（綁定流程）與推播 Function（依範圍選擇的觸發方式）。
5. `patient.html` 新增「綁定 LINE」卡片：顯示綁定碼、綁定狀態、（若做展示等級）測試推播按鈕。
6. `firebase deploy --only functions,firestore:rules,hosting`。
7. 用真實 LINE 帳號跑一次完整流程驗證（產生碼 → LINE 傳碼 → 綁定成功 → 收到推播），不只看程式碼就當完成。

---

## 驗證方式

- `npm run test:rules` 涵蓋新 collection 的存取控制。
- 手動端對端測試：瀏覽器登入病患帳號 → 產生綁定碼 → 用真實 LINE 帳號加官方帳號好友並傳碼 → 確認 Firestore `line_bindings/{username}` 出現且 `active:true` → 觸發推播（測試按鈕或事件）→ 確認 LINE 端真的收到訊息。
- 檢查 Cloud Functions log（`firebase functions:log`）確認 webhook 簽章驗證與推播呼叫沒有錯誤。
