# LINE 整合 — 需要你手動操作的步驟

**程式碼狀態：P0 + P1 已完成並通過測試（2026-09-09）。**
接下來卡住的全部是「我做不到、只能你本人做」的事：申請 LINE 帳號、綁信用卡、輸入密鑰。

架構與決策說明見 `linebot.md`。這份文件只講你要做什麼。

---

## 已經完成的部分（不用你動手）

| 項目 | 位置 |
|---|---|
| Cloud Functions 專案骨架 | `functions/`（6 支 Function、11 個模組） |
| 綁定流程（產生碼／核銷／解除／封鎖） | `functions/src/bindings.js`、`callable.js`、`webhook.js` |
| 每日用藥彙整卡 + 一鍵回報 | `functions/src/reminder.js`、`flex.js`、`adherence.js` |
| 新處方跨院交互作用警示 | `functions/src/prescription.js`、`ddi.js` |
| 四個新集合的安全規則 | `firestore.rules` 末段 |
| 規則測試（新增 17 條） | `tests/firestore-rules.test.mjs` → **240/240 通過** |
| 病患端「LINE 提醒」頁 | `patient.html` 側欄第四項（已在瀏覽器驗證可正常渲染） |
| 部署設定 | `firebase.json`（functions 區塊、predeploy、hosting ignore） |

全部測試：`npm test` → catalog 36 + ddi 67 + fhir 14 + rules 240 = **357 全過**。

---

## 你要做的事（依序，約 40 分鐘）

### 步驟 1️⃣ — Firebase 升級 Blaze 方案

Cloud Functions 的前提。**預期帳單 0 元**（用量遠低於免費額度），但必須綁信用卡。

1. 開 https://console.firebase.google.com/project/medsafe-554b7/usage/details
2. 點「修改方案」→ 選 **Blaze（隨用隨付）**
3. 綁定信用卡
4. 建議同時設一個預算警示（例如 NT$100），超過會寄信通知

> 免費額度參考：Cloud Functions 每月 200 萬次呼叫、Cloud Scheduler 3 個工作、Secret Manager 少量存取。本專案預估每月呼叫數 < 1,000。

---

### 步驟 2️⃣ — 建立官方帳號並啟用 Messaging API

> ⚠️ **2024/9/4 起流程改了**：不能再直接在 LINE Developers Console 建立 Messaging API channel。
> 必須先建 **LINE 官方帳號**，再從官方帳號啟用 Messaging API，channel 才會自動產生。
> 網路上 2024 年以前的教學（包括「Create a new channel → Messaging API」那一套）都已失效。

全程免費。分三站，依序做完。

#### 2-1　建立官方帳號 — https://manager.line.biz/

1. 用你的 LINE 帳號登入
2. 點「**建立帳號**」
3. 填寫：
   - **帳號名稱**：`MedSafe 用藥提醒`
     　→ 這會顯示在長輩的好友清單裡，也會出現在投稿影片中
   - **大頭貼**：投稿影片會拍到，建議先準備一張
   - **電子郵件**
   - **公司／店家所在國家或地區**：台灣
   - **業種**：醫療保健 → 其他醫療保健
4. 送出後帳號就建立好了（預設是免費的「輕用量」方案）

#### 2-2　啟用 Messaging API（同一個網站）

1. 在官方帳號管理頁面，點右上角「**設定**」
2. 左側選單選「**Messaging API**」
3. 點「**啟用 Messaging API**」
4. 這一步會要你選 **Provider**：
   - 第一次使用要「建立新的 Provider」，名稱填 `MedSafe`
   - ⚠️ **Provider 名稱會公開顯示給使用者看**，不要填個人本名
5. 同意條款 → 完成
6. 畫面會直接顯示 **Channel ID** 與 **Channel secret** → **Channel secret 先複製起來**

#### 2-3　關掉兩個罐頭回覆（還是在 manager.line.biz）

不關的話，長輩傳綁定碼給官方帳號時，會先收到 LINE 內建的罐頭回覆，蓋掉我們自己的回應。

1. 「**設定**」→ 左側「**回應設定**」
2. 四個開關這樣設：

   | 開關 | 設成 | 為什麼 |
   |---|---|---|
   | **Webhook** | **開啟** | 不開，我們的 Function 收不到任何訊息，整套功能等於沒接上 |
   | **自動回應訊息** | **關閉** | 開著會蓋掉綁定成功／回報成功的回覆 |
   | **加入好友的歡迎訊息** | **關閉** | 歡迎訊息由我們的 Function 發，內容才會正確引導綁定 |
   | 聊天 | 開或關都可以 | 2022 年起聊天與 Webhook 可並存，不影響 |

#### 2-4　取得 Channel access token — https://developers.line.biz/console/

1. 用**同一個 LINE 帳號**登入
2. 會看到剛才建立的 Provider（`MedSafe`）→ 點進去 → 點那個 Messaging API channel
3. 切到「**Messaging API**」分頁：
   - 找到 **Channel access token (long-lived)** → 按「**Issue**」→ **複製**
   - 同一頁上方會看到 **Bot basic ID**（`@` 開頭）→ **記下來**
4. 切到「**Basic settings**」分頁：
   - 最下方有 **Channel secret**（如果 2-2 沒抄到，在這裡拿）

**做完你手上會有三個值：**

```
Channel secret        →  32 碼英數        （Basic settings 分頁）
Channel access token  →  很長一串          （Messaging API 分頁，按 Issue）
Bot basic ID          →  @xxxxxxx        （Messaging API 分頁）
```

三個都拿到後，接步驟 3️⃣。

---

### 步驟 3️⃣ — 把密鑰寫進 Secret Manager

在專案目錄 `D:\競賽\GCA\Source_Code\Security-main` 執行。指令會提示你貼上值，**貼上後按 Enter**：

```bash
firebase functions:secrets:set LINE_CHANNEL_SECRET
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
```

然後把 Bot basic ID 寫進 `functions/.env`（這個不是機密，是公開的官方帳號 ID）：

```bash
echo "LINE_BASIC_ID=@你的BasicID" > functions/.env
```

> `functions/.env` 已在 `.gitignore` 內，不會進版控。
> 沒設也能運作，只是綁定頁不會出現「用 LINE 傳送這組碼」的一鍵按鈕，改成手動輸入 8 碼。

驗證：
```bash
firebase functions:secrets:get LINE_CHANNEL_SECRET
```

---

### 步驟 4️⃣ — 部署

```bash
cd D:/競賽/GCA/Source_Code/Security-main
npm run test:rules                                    # 先確認 240/240
firebase deploy --only functions,firestore:rules,hosting
```

> `firestore.rules` 與 `hosting` 必須一起部署（見 `DEPLOY_CHECKLIST.md` §2）。
> 首次部署 Functions 會花 3–5 分鐘，並可能要求啟用幾個 Google Cloud API——照提示按 Y 即可。

部署完成後，輸出裡會有一行 webhook 網址，長這樣：
```
https://asia-east1-medsafe-554b7.cloudfunctions.net/lineWebhook
```
**把它複製下來。**

---

### 步驟 5️⃣ — 回 LINE Console 設定 Webhook

1. 回到 Messaging API channel 的 **Messaging API** 分頁
2. **Webhook URL** 填入上一步複製的網址
3. 按 **Verify** → 應該顯示 **Success**
4. 把 **Use webhook** 打開（Enabled）

> Verify 失敗時先看 `firebase functions:log --only lineWebhook`。
> 最常見的原因是 Channel secret 貼錯（log 會寫 `x-line-signature 驗證失敗`）。

---

### 步驟 6️⃣ — 端對端驗證（用你自己的真實 LINE）

照順序做，每一步都要看到預期結果才往下走：

- [ ] 開 https://medsafe-554b7.web.app → 用 `patient01` 登入
- [ ] 側欄點「LINE 提醒」→ **紅色錯誤橫幅應該消失了**（規則已部署）
- [ ] 按「產生綁定碼」→ 出現 8 碼與倒數計時
- [ ] 用手機 LINE 加官方帳號好友（掃 QR 或搜尋 Bot basic ID）
- [ ] 把 8 碼傳給它 → 收到「綁定成功」
- [ ] 網頁**不用重新整理**，5 秒內會自己翻成「已連結 LINE」
- [ ] 按「傳送測試提醒」→ 手機收到當日用藥卡（3 個時段按鈕）
- [ ] 按卡片上「✓ 08:00 已服用」→ 收到「已記錄 08:00 的用藥」
- [ ] 回網頁重新整理 → 首頁「今日用藥提醒」的 08:00 已打勾、進度變 1/3
- [ ] 在手機 LINE 傳「藥箱」→ 收到 6 種藥的清單與交互作用摘要

**最後是展示影片的主角，用醫師端做：**

- [ ] 另開瀏覽器（或無痕視窗）用 `doctor` 登入 `dashboard.html`
- [ ] 對病患 `patient01` 開一個會產生**重大**交互作用的藥
- [ ] **手機當場收到跨院警示卡**，卡上會寫「台大醫院 × 長庚醫院」

---

## 排錯速查

| 症狀 | 原因與處置 |
|---|---|
| Webhook Verify 失敗 | Channel secret 貼錯。`firebase functions:log` 會寫「x-line-signature 驗證失敗」 |
| callable 回 `not-found` | 前端沒指定區域。已在 `js/firebase-config.js` 寫死 `asia-east1`，若仍發生請確認部署區域也是 asia-east1 |
| 綁定頁紅色錯誤橫幅 | `firestore.rules` 還沒部署。跑步驟 4️⃣ |
| 綁定成功但收不到推播 | 看 `firebase functions:log`。若出現 429 = 當月 200 則免費額度用完 |
| 交互作用警示沒出現 | 只有 major / contraindicated 才推（刻意的，避免警示疲勞）。確認新藥有 ATC code |
| 回報記到錯誤的日期 | 時區問題。`functions/src/taipei-time.js` 已處理，若仍發生請回報 |

---

## Phase 0 — LIFF 身分橋接：✅ 已完成（2026-09-11）

`patient.html?liff=1` 已可用，端對端驗證通過（已綁定帳號直接開 LIFF 免登入進入藥箱頁）。

LIFF ID：`2011556856-q7GxQLhS`　LINE Login Channel ID：`2011556856`（都寫在 `functions/.env` 與 `js/line-liff-config.js`）。

**過程中踩到、記下來避免重工的坑：**
- `admin.auth().createCustomToken()` 在 Cloud Functions 裡需要執行用的服務帳戶
  （`{專案編號}-compute@developer.gserviceaccount.com`）有 **Service Account Token
  Creator**（服務帳戶憑證建立者）這個 IAM 角色，否則會丟
  `auth/insufficient-permission`（signBlob 被拒）。這不是程式碼問題，是專案層級的
  IAM 設定，**換了 Firebase 專案要記得重加**。已在 `functions/src/exchange.js`
  補上明確的 try/catch 與 log，不會再被誤判成別的錯誤。
- 前端曾經把「LIFF 登入失敗的任何原因」全部顯示成「尚未綁定 LINE」，導致上面這個
  IAM 問題被誤診成綁定問題。已修正為依 `HttpsError` code 分流（見 `patient.html`
  的 `renderLiffError()`）——`failed-precondition` 才是真的沒綁定，其餘一律顯示
  通用錯誤畫面並保留代碼，不要再合併回同一句話。

<details>
<summary>建立步驟記錄（僅供之後換帳號/專案時參考，正常情況不需要再做一次）</summary>

## Phase 0 — LIFF 身分橋接：你要做的事（約 10 分鐘）

**程式碼已完成**（`functions/src/exchange.js`、`js/liff-bridge.js`、`js/line-liff-config.js`，
`tests/line-exchange.test.mjs` 已通過）。卡住的只剩「在 LINE Developers Console 建立
LINE Login channel + LIFF app」——這件事跟申請 Messaging API 一樣，只有你本人的
LINE 帳號能做。

### 步驟 1️⃣ — 建立 LINE Login channel

1. 開 https://developers.line.biz/console/，用同一個 LINE 帳號登入
2. 點進步驟 2️⃣ 建立過的 Provider（`MedSafe`）
3. 「**Create a new channel**」→ 選 **LINE Login**
4. 填寫：
   - **Channel name**：`MedSafe LIFF`（使用者不太會看到這個名字，隨意）
   - **App types**：勾 **Web app**
5. 建立後，切到「**Basic settings**」分頁，找到 **Channel ID**（一串數字）→ **記下來**

### 步驟 2️⃣ — 在這個 channel 底下新增 LIFF app

1. 同一個 channel 內，切到「**LIFF**」分頁 → 「**Add**」
2. 填寫：
   - **LIFF app name**：`MedSafe 病患`
   - **Size**：`Full`
   - **Endpoint URL**：`https://medsafe-554b7.web.app/patient.html?liff=1`
     　⚠️ 一定要帶 `?liff=1`，`js/liff-bridge.js` 靠這個參數判斷要不要啟動 LINE 登入
   - **Scope**：勾 `openid`（一定要）與 `profile`
   - **Bot link feature**：可選 `On (Aggressive)`，讓開 LIFF 的人自動也加好友
3. 建立後會拿到一串 **LIFF ID**（格式像 `1234567890-AbCdEfGh`）→ **記下來**

**做完你手上會有兩個值**（都不是機密，是公開 ID）：

```
LINE Login Channel ID  →  一串數字
LIFF ID                →  1234567890-AbCdEfGh
```

### 步驟 3️⃣ — 把兩個值交給我，我會做

- 把 **LIFF ID** 寫進 `js/line-liff-config.js` 的 `window.LIFF_ID`
- 用 `firebase functions:config:set` 或 `.env` 把 **Channel ID** 設進
  `LINE_LOGIN_CHANNEL_ID`（非機密，不需要 Secret Manager）
- 重新部署 `functions,hosting`
- 跑 `npm run test:exchange` 確認邏輯正確

### 步驟 4️⃣ — 端對端驗證（用你自己的真實 LINE）

- [ ] 先照 P0 既有流程用網頁版完成一次 LINE 綁定（若還沒綁）
- [ ] 手機 LINE 開啟官方帳號的圖文選單，或直接貼上
      `https://liff.line.me/{LIFF_ID}` 這個網址
- [ ] 應該直接看到 `patient.html` 正常渲染（不用輸入帳號密碼）
- [ ] 用**未綁定**的另一個 LINE 帳號開同一個連結 → 應該看到「尚未綁定 LINE」提示頁，
      而不是被導去 `login.html`

</details>

---

## Phase 2/3（依賴 Phase 0，尚未實作）

| 項目 | 內容 | 估時 |
|---|---|---|
| LIFF 數位藥箱 | 複用 `patient.html` 既有藥箱區塊，Phase 0 做完後零額外身分工程 | 0.5 天 |
| LIFF 掛號 | 新頁面 `liff-appointment.html`，複用 `DbService.appointments` | 0.5 天 |
| 圖文選單擴充 | 六宮格已完成（見 `04_Security_Audit/0910.md`），「線上預約」格從 COMING_SOON 換成真正的 LIFF 連結 | 低 |

`linebot.md` §9 的建議是 **9/17 起功能凍結**，全部投入影片與簡報——Phase 0 做完
已經足夠讓「藥箱」「掛號」用 LIFF 免登入直接開啟，是否再做 Phase 2/3 視進度而定。
