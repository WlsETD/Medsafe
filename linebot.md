# LINE 整合研究 — 用藥提醒／回報、掛號、數位藥箱

**狀態**：研究與架構設計，等待下方「你需要決定的事項」確認後開始實作。
**建立**：2026-09-08（僅用藥提醒）　**擴寫**：2026-09-09（納入掛號、數位藥箱、成本與價值分析）

---

## 0. 一句話結論

三件事**不是同一種技術**，硬用同一種做會做壞其中兩件：

| 你要的功能 | 該用的技術 | 為什麼 |
|---|---|---|
| 用藥提醒**通知** | Messaging API **Push** | 系統主動找人，只有 push 做得到 |
| 用藥**確認**（吃了沒） | Flex Message **Postback** + **Reply** | 一鍵回報，且 Reply API **不計費** |
| **掛號** | **LIFF**（LINE 內建瀏覽器）+ Push 提醒 | 需要選科別/醫師/時間的表單，Bot 對話流程做這個很痛苦 |
| 查看**數位藥箱** | **LIFF** + 免費 Reply 摘要卡 | 六種藥＋交互作用警示是資訊密集畫面，聊天泡泡放不下 |

而讓這三件事能共用同一套權限的關鍵，是一個**身分橋接**：
**LINE ID Token → Cloud Function 驗證 → Firebase Custom Token → 前端 `signInWithCustomToken`**。

做了這件事，LIFF 裡開的頁面就是一個「已用 Firebase Auth 登入的病患」，**現有 `firestore.rules` 一條都不用改寫讀取邏輯，整個安全邊界原封不動**。這是本研究最重要的一個結論——它決定了 LINE 整合是「加一層皮」還是「在安全邊界上開後門」。

---

## 1. 前提：這件事必然要新增伺服器端

MedSafe 目前是**純靜態前端**（Vue3 CDN + Tailwind CDN，無 build step）＋ Firebase Auth/Firestore，存取控制完全靠 `firestore.rules`（見 `CLAUDE.md`）。repo 裡沒有 `functions/` 目錄，`package.json` 沒有 `firebase-functions`/`firebase-admin`。

LINE Messaging API 的 **Channel Access Token 與 Channel Secret 是機密**，不能出現在前端。CLAUDE.md 已明文記錄「純靜態前端無法保管密鑰」這條原則（FHIR 那段就是因為這樣才把自架代理伺服器整個砍掉）。

**所以 LINE 整合必然是本專案第一個伺服器端元件（Cloud Functions），這是架構上的分水嶺，不是加幾支 JS。** 連帶需要 Firebase **Blaze（隨用隨付）方案**——雖然這種規模幾乎確定落在免費額度內（Cloud Functions 每月 200 萬次呼叫、Cloud Scheduler 3 個工作免費），但必須綁信用卡。

### 一個必須先講清楚的取捨

Cloud Functions 用 **Firebase Admin SDK**，而 Admin SDK **不受 `firestore.rules` 管**。這是刻意的信任邊界，不是漏洞——但本專案的整個安全論述建立在「規則是唯一真正的存取控制邊界」上，所以：

- **凡是「讀病患資料拿去顯示」的路徑，一律走 Custom Token + 前端 SDK，讓規則照常生效**（見 §2）。
- **只有三種操作用 Admin SDK**：核銷綁定碼、寫入 `line_bindings`（前端不可自行宣稱綁定）、以及推播時讀取提醒內容。這三者都必須在 `CLAUDE.md` 補一段說明，否則日後稽核會被判成「繞過規則」。

---

## 2. 核心設計：身分橋接（LINE ↔ Firebase Auth）

### 問題

MedSafe 的身分是 Firebase Auth 的 `uid`（`user_roles/{uid}` 是唯一可信身分索引，username 是 `username@medsafe.local` 合成的假 email）。
LINE 的身分是 `lineUserId`（`U` 開頭的字串）。

長輩在 LINE 裡點「我的藥箱」，系統只知道 `lineUserId`。要顯示藥箱就得知道對應的 Firebase 帳號——而且**不能讓長輩再打一次帳號密碼**，否則這個功能的意義（比開網頁簡單）就沒了。

### 解法（兩段）

**A. 綁定一次（首次）**

```
病患在 patient.html（已登入）點「綁定 LINE」
   → 呼叫 callable Function 產生 6 碼短效綁定碼（10 分鐘）
   → 寫入 line_link_codes/{code} { username, uid, expiresAt, used:false }
   → 畫面同時顯示 QR code（加官方帳號好友）與那組碼

病患在 LINE 加好友、傳送那組碼
   → lineWebhook 收到訊息事件
   → 驗證 x-line-signature（用 Channel Secret，防偽造請求）
   → 查 line_link_codes/{code}：未過期、未使用
   → 寫 line_bindings/{username} { uid, lineUserId, linkedAt, active:true }
   → 寫 line_users/{lineUserId}  { username, uid }      ← 反向索引，見下
   → 標記該碼 used:true（不刪除，留稽核軌跡）
   → Reply（免費）「綁定成功，王大明先生您好」
```

> **既有規劃漏掉的一點**：原稿只設計了 `line_bindings/{username}`。但 webhook 與 LIFF 拿到的是 `lineUserId`，用它反查 username 需要**查詢集合**——而 Security Rules 不能查詢集合。必須另立 `line_users/{lineUserId}` 反向索引文件，這正是本專案 `care_relations/{病患}__{醫師}` 與 `patient_index/{身分證}` 用過兩次的同一手法（見 `firestore.rules`）。

**B. 每次進 LIFF（之後）**

```
LIFF 頁面載入 → liff.init() → liff.getIDToken()
   → POST 到 Cloud Function lineExchangeToken（帶 ID Token）
   → Function 呼叫 LINE 的 POST https://api.line.me/oauth2/v2.1/verify 驗簽
      （官方明文要求：不可信任前端傳來的 userId，只能傳 ID Token 由伺服器驗）
   → 取出 sub（= lineUserId）→ 查 line_users/{lineUserId} → 得 uid
   → admin.auth().createCustomToken(uid)
   → 前端 firebase.auth().signInWithCustomToken(token)
   → 從這一刻起，這個 webview 就是一個正常登入的病患
      DbService 全部照用、firestore.rules 全部照常生效
```

**這一段是整個整合的價值所在**：掛號、數位藥箱兩個功能因此**零安全邊界改動**——不是「我們相信 Function 有檢查」，而是「規則仍然是那道牆，只是換一扇門進來」。這句話在稽核與評審面前的份量，和它的工程量完全不成比例。

### 新增三個 Firestore collection

| Collection | 內容 | 誰能寫 | 誰能讀 |
|---|---|---|---|
| `line_link_codes/{code}` | `{ username, uid, expiresAt, used }` | 病患本人 create（只能建自己的、`expiresAt` 須為伺服器時間 + 短效期）；Function 核銷 | **無人可讀**（前端讀得到別人的碼＝可枚舉的授權漏洞，比照 `patient_index` 的 get-only／禁 list 精神） |
| `line_bindings/{username}` | `{ uid, lineUserId, linkedAt, active }` | 僅 Function（Admin SDK） | 病患讀自己的（前端顯示「已綁定」） |
| `line_users/{lineUserId}` | `{ username, uid }` | 僅 Function | **無人可讀**（能讀＝可由 LINE ID 反查病患身分） |

解除綁定走 Function，設 `active:false` 而**不整筆刪除**——呼應本專案「紀錄不可單方面抹除」的一貫設計（`appointments`/`care_relations`/`consents` 的 `allow delete: if false`）。

三個 collection 的規則變更都要照專案規矩補 `tests/firestore-rules.test.mjs` 對照測試，跑 `npm run test:rules`。

### 密鑰

`firebase functions:secrets:set LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN`（Secret Manager），不進 git、不進前端。

---

## 3. 功能一：用藥紀錄的通知與確認

### 3.1 現有資料模型（已確認，可直接沿用）

單一文件 `patient_data/{username}`，沒有子集合：

- **`reminders`**：陣列，`{ time: "08:00", text: "藥名（多藥以、合併）", completed: false }`。
  `completed` 是舊欄位，**已不是「今天吃了沒」的依據**。
- **`adherenceLog`**：map，key 是**本地時區**日期字串 `YYYY-MM-DD`（刻意不用 `toISOString()`，避免 UTC/UTC+8 位移），value 是當天快照 `{ total, schedule:[{time,text}], taken:[{time,text,at}] }`，只保留最近 30 天（`KEEP_DAYS`，避免撞 Firestore 單文件 1MB 上限）。
- `DbService.adherence.slotKey(reminder)` = `time + '|' + text`（同一時間可能有多筆提醒，故時間不足以當鍵）。
- `DbService.adherence.dayKey()`：以本地時鐘算日期字串。

> ⚠️ **Cloud Functions 預設時區是 UTC。** 推播 Function 必須在伺服器端重現同一套 UTC+8 邏輯（設定 `timeZone: 'Asia/Taipei'` 並自行組日期字串），否則「今天」的定義會和前端對不上——症狀會是：早上 8 點前的回報記到前一天，然後「今天」永遠顯示未回報。這個 bug 前端已經踩過一次並在 `db-service.js` 留了註解，別在伺服器端再踩一次。

### 3.2 「通知」有兩種，價值差很多

**(a) 每日服藥提醒**（例行）
到點推播「該吃 08:00 的藥了」。這是一般用藥 App 都有的功能。

**(b) 新處方 / 交互作用警示**（事件觸發）← **這才是 MedSafe 獨有的**
醫師在 A 醫院開新藥，DDI 引擎判定與病患在 B 醫院的既有用藥有重大交互作用 → **當下**推播到病患 LINE：

> ⚠️ 用藥安全提醒
> 今天在**台大醫院**新增的 **Warfarin（華法林）**，
> 與您在**長庚醫院**的 **Aspirin（阿斯匹靈）** 併用有**重大**出血風險。
> 　[看詳細說明]　[通知我的醫師]

這一則訊息把整個專案的核心命題——**跨院多重用藥沒人看得到全貌**——變成一件在長輩手機上真的會發生的事。展示影片如果只能放一個 LINE 畫面，放這則。

技術上它是 **Firestore `onDocumentUpdated('patient_data/{username}')` 觸發**，比對 `medications` 陣列是否變長，變長就跑 DDI 引擎（引擎是純 JS，`js/ddi-engine.js` + `js/ddi-rules-ddinter.js` 可直接在 Node 端 require，不需重寫）→ 有 major/contraindicated 就推播。

> **注意**：處方寫入時前端已經跑過一次 DDI 檢查並寫入 `safetyCheck`（規則強制要求，見 `firestore.rules` 的處方安全閘門）。Function 端可以直接讀 `safetyCheck.verdict === 'risk'` 而不必重跑引擎——**但要重跑**，理由是 `safetyCheck` 是醫師端自己宣告的，而推播給病患的警示應該由系統獨立判定。兩者不一致本身就值得記一筆 log。

### 3.3 「確認」：一鍵回報，而且免費

Flex Message 帶 postback 按鈕：

```
┌─────────────────────────┐
│ 💊 08:00 該吃藥了        │
│ 華法林 5mg、阿斯匹靈 100mg │
│                         │
│ [ ✅ 我吃了 ]  [ ⏰ 30分後再提醒 ] │
└─────────────────────────┘
```

按下去 → webhook 收到 `postback`，`data = action=taken&day=2026-09-09&slot=08:00|華法林、阿斯匹靈`
→ Function 用 Admin SDK 寫 `adherenceLog[day].taken` 追加一筆 `{time, text, at}`
→ **Reply**（不是 push）「已記錄 ✅ 08:00 的藥」

**Reply API 不計費**（LINE 官方明列「一對一聊天訊息、自動回應、AI 回應、Messaging API 的 Reply API」為免費訊息）。所以**回報的確認回覆完全不花錢**，只有主動提醒那一則計費。這對成本結構影響很大，見 §7。

**防重複推播**：Cloud Scheduler 每 15 分鐘掃一次，必須有冪等鎖。用 Admin SDK 以 `create()`（而非 `set()`）寫 `line_push_log/{username}__{dayKey}__{slotKey}`——文件已存在時 `create` 會失敗，這個失敗就是鎖。不要用「先讀再寫」判斷，那在重疊執行時會雙推。

### 3.4 隱私：藥名要不要出現在聊天室？

這是本專案該想、而多數用藥 App 沒想的問題。訊息會**留在手機聊天室**，也**經過 LINE 的伺服器**。長輩的手機常常給家人、看護、孫子用。

建議在綁定同意書中明確揭露，並提供**隱私模式**開關：

| 模式 | 訊息內容 |
|---|---|
| 一般 | 「08:00 該吃藥了：華法林 5mg、阿斯匹靈 100mg」 |
| 隱私（預設？） | 「08:00 該吃藥了（2 種），點開查看」→ 藥名只在 LIFF 裡顯示 |

隱私模式讓藥名只存在於「打開 App 且已驗證身分」的情境，聊天室裡不留醫療資訊。**這個開關本身就是一張投影片**——它證明團隊理解「把醫療資料推到第三方通訊軟體」是一個需要被設計的取捨，而不是一個功能勾選。

---

## 4. 功能二：掛號

### 4.1 現有資料模型（已確認）

`appointments/{autoId}`：`{ patient, patientName, doctor, doctorName, department, scheduledAt, status, createdAt, note }`
狀態：`booked` / `arrived` / `finished` / `cancelled`，前兩者算「進行中」。

**本專案的掛號不只是掛號，它是授權事件**（`firestore.rules` 有長篇說明）：掛號時 `DbService.appointments.create()` 會**另外**寫一份 `care_relations/{病患}__{醫師}`（90 天效期），醫師才看得到病歷。取消掛號、且與該醫師無其他進行中掛號時，關係一併撤銷。

規則上，病患自己建立掛號需要：`isOwnUsername(patient)`、`status == 'booked'`、`createdAt == request.time`、欄位白名單。**這些條件在 Custom Token 登入後全部自動滿足**——因為那就是病患本人的 Auth session。

### 4.2 做法

**LIFF 頁面 `liff-appointment.html`**，複用 `DbService.appointments`：

```
圖文選單「掛號」→ LIFF 開啟
   → 自動 Custom Token 登入（§2）
   → 選科別（下拉）、輸入醫師帳號、選日期
   → DbService.appointments.create(...)  ← 規則照常把關
   → liff.closeWindow()
   → Function 推播 Flex 掛號確認卡（含 [取消掛號] postback）
```

**加上 Push 提醒**（這才是 LINE 化真正省事的地方）：
- **回診前一天 18:00**：「明天 09:30 台大醫院 一般內科 李醫師」＋ `[加入行事曆] [取消]`
- **掛號成功／取消**：即時確認卡

### 4.3 誠實的定位（重要，不要在影片裡講過頭）

MedSafe 的掛號是**展示型**的：病患自行輸入醫師 username，系統無法驗證那是不是執業醫師，也沒有串接任何醫院 HIS 的排班/名額（`firestore.rules` 自己就寫了這個限制）。而**健保署官方帳號早就有掛號導引**，各大醫院也都有自己的 LINE 掛號與看診進度查詢——「能在 LINE 掛號」不是差異點。

**差異點是：在 MedSafe 掛號的同一個動作，就是把你的跨院用藥資料授權給那位醫師，而且 90 天後自動到期。** 別家的 LINE 掛號只是排隊；這裡的掛號是一次有期限、可撤銷、留痕的資料授權。這句話要講清楚，否則評審會覺得你在重做一個已經有很多人做的東西。

---

## 5. 功能三：數位藥箱

### 5.1 現有資料模型

`patient_data/{username}.medications`：`[{ atc, name, zhName, dosage, freq, category, hospital }]`
`patient.html` 的「我的數位藥箱」區塊已存在，藥品標示與交互作用由 `DdiEngine` 即時計算（**按 ATC 碼比對，不是藥名字串**——藥名比對正是最初的 bug）。

### 5.2 兩層做法（建議都做，成本相反）

**第一層：文字指令 → Reply 摘要卡（完全免費）**
長輩傳「藥箱」，或按圖文選單 → **Reply**（不計費）一張 Flex 卡：

```
┌──────────────────────────┐
│ 💊 王大明的數位藥箱        │
│ 目前 6 種藥，來自 4 家醫院  │
│ ──────────────────────── │
│ ⚠️ 1 項重大交互作用        │
│ 華法林 × 阿斯匹靈          │
│ ──────────────────────── │
│ [ 查看完整藥箱 ]  ← LIFF   │
└──────────────────────────┘
```

Reply API 免費，所以**病患主動查詢想查幾次都不花錢**。這一層的成本結構好到值得刻意設計進去：把「主動推播」保留給真正緊急的事，把「隨時可查」做成零成本。

**第二層：LIFF 完整藥箱**
Custom Token 登入 → 載入既有的藥箱 UI（可從 `patient.html` 抽出來），完整六種藥、DDI 警示、`check.html` 的交互作用查詢也可以直接掛進來。

### 5.3 一個實測到的效能考量

LIFF 要顯示 DDI 警示就得載入引擎與規則庫：

| 檔案 | 大小 |
|---|---|
| `js/ddi-rules-ddinter.js` | 176 KB |
| `js/ddinter-drugs.js` | 78 KB |
| `js/db-service.js` | 43 KB |
| `js/drug-catalog.js` | 42 KB |
| `js/ddi-engine.js` | 18 KB |
| **合計** | **約 355 KB**（未壓縮） |

Firebase Hosting 會自動 gzip，實際傳輸約 4 分之 1，在 4G 上可接受。**但 `firebase.json` 目前對所有 `*.js` 下了 `Cache-Control: no-cache`**（那是為了修一次「新 HTML 配到快取的舊 JS」的部署事故加的，見 `DEPLOY_CHECKLIST.md`）——意思是**每次開啟 LIFF 都會重抓這 355 KB**。

LIFF 情境下這個設定值得調整：規則庫這類內容穩定的大檔可以改用檔名帶版本號（`ddi-rules-ddinter.v3.js`）＋長快取，既解決部署事故，也讓長輩第二次開藥箱是秒開。**不要直接把 `no-cache` 拿掉**——那會把當初那個事故放回來。

### 5.4 目前資料模型沒有的東西

**藥品外觀（照片、顏色、形狀、刻痕）**。長輩最需要的其實是「桌上這顆白色圓形的是哪一顆」——但 `medications` 裡沒有任何外觀欄位，DDInter 資料也不含。要做得補資料來源（食藥署藥品許可證資料集有部分外觀資訊）。**這是未來工作，不建議這次做**，但值得在簡報的「未來展望」提一句，因為它顯示你知道真實使用者的痛點在哪。

---

## 6. 應用層面：長輩真的會用嗎

### 6.1 為什麼是 LINE 而不是 App 或網頁

- 長輩手機上**已經有 LINE**，不用再學一個 App、不用記一組帳密、不用擔心更新。
- **圖文選單（Rich Menu）**是長輩唯一熟悉的「按鈕介面」——六格大按鈕、大字，比任何自製 UI 都更接近他們既有的操作習慣。
- 實務數據佐證這條路走得通：大林慈濟醫院導入 LINE 官方帳號後，**準時報到率上升 11.7%、掛號使用率提升 44%、滿意度 82%**。

**建議圖文選單（2×3，六格）**：

```
┌──────────┬──────────┬──────────┐
│ 💊 我的藥箱 │ ✅ 我吃藥了 │ 📅 我的掛號 │
├──────────┼──────────┼──────────┤
│ 🔍 藥物查詢 │ 📄 用藥時間表│ 👨‍👩‍👧 通知家人 │
└──────────┴──────────┴──────────┘
```

- 「藥物查詢」直接開既有的 `check.html`（免登入交互作用查詢，已經做好了）
- 「用藥時間表」直接開既有的 `schedule.html`（可列印的免登入用藥時間表，已經做好了）
- **這兩格幾乎零成本**——把 LIFF URL 指向現成頁面就好，卻讓選單一次從四格變六格

### 6.2 誰收通知：病患 vs 家屬

目前 `patient_data` 的讀取權限是：本人、有效照護關係的醫師、緊急破窗醫師、admin。**完全沒有「家屬共同查看」機制**——這是「家屬共照模式」（第二優先另一項）還空白的原因。

所以：**LINE 綁定這次只做「病患本人」**。家屬綁定需要一整套新的授權資料模型（誰能代替誰確認吃藥？家屬按「已服用」算不算病歷記錄？），那是共照模式的範圍。

**但可以留一個低成本的接口**：把「通知家人」做成一個**單向、不含醫療內容**的功能——病患自己按下去，推播給已綁定的家屬 LINE：「王大明今天的藥都吃了 ✅」或「王大明今天還有 2 次藥未回報」。**只送遵從狀態，不送任何藥名/病名**，因此不需要動 `patient_data` 的讀取權限，也不需要共照模式的完整授權模型。這是「家屬共照」這條線上，工程量最小而感受最強的一步。

### 6.3 失效路徑（要在文件與 UI 裡誠實揭露）

| 情況 | 後果 | 對策 |
|---|---|---|
| 病患封鎖官方帳號 | push 靜默失敗 | webhook 收 `unfollow` 事件 → 標記 `active:false`，前端顯示「LINE 提醒已中斷」 |
| 訊息額度用完 | 當月後續 push 全部失敗 | Function 記錄失敗、前端顯示狀態。**絕不可讓「沒收到提醒」被誤解為「今天不用吃藥」** |
| 手機遺失 | 聊天室裡的用藥史外洩 | 隱私模式（§3.4）；`patient.html` 隨時可解除綁定 |
| 長輩按了「我吃了」但其實沒吃 | 遵從率數據失真 | 這是**所有**自我回報系統的共同限制，必須在醫師端標示「病患自述，非系統驗證」——本專案對 `consents`/`patient_summaries` 已經是這個立場，保持一致 |

---

## 7. 成本：真實數字

### 7.1 LINE 官方帳號（2026/11/1 起新價）

| 方案 | 月費（未稅） | 每月免費訊息 | 加購 |
|---|---|---|---|
| 輕用量 | 0 元 | 200 則 | 不可加購 |
| 中用量 | 800 → **1,000 元** | 3,000 則 | 不可加購 |
| 高用量 | 1,200 → **1,400 元** | 6,000 則 | 0.2 元/則（前 5 萬則） |

**不計入則數**：加好友歡迎訊息、一對一聊天訊息、自動回應、AI 回應、**Messaging API 的 Reply API**。

### 7.2 換算成「一位病患一個月多少錢」

| 推播設計 | 每人每月則數 | 輕用量可服務 | 高用量加購時的邊際成本 |
|---|---|---|---|
| 每個時段推一則（3 次/日） | 90 則 | **2 人** | 約 **18 元/人/月** |
| 每日一張彙整卡（早上一則，卡上三個時段按鈕） | 30 則 | **6 人** | 約 **6 元/人/月** |
| 彙整卡 + 只在未回報時補推一次 | 約 45 則 | 4 人 | 約 9 元/人/月 |

**這張表是簡報裡的「商業可行性」那一頁**：一位長輩每月 6～18 元的通訊成本，對照的是「一次因交互作用的急診」。同時它也逼出一個好的產品決策——

> **建議採「每日一張彙整卡」**：早上 07:30 推一則，卡上三個時段各一個按鈕，吃完哪個按哪個（回報走 Reply，免費）。訊息數降到三分之一，長輩的干擾也降到三分之一，而回報功能完全不減。**警示類訊息（新處方 DDI）不受此限，一律即時推播。**

### 7.3 Firebase

Blaze 方案必須開通（綁卡），但這個規模幾乎確定全落在免費額度內：Cloud Functions 每月 200 萬次呼叫、Cloud Scheduler 3 個工作免費、Secret Manager 少量存取免費。**實際帳單預期為 0 或個位數新台幣。**

---

## 8. 價值：為什麼這件事值得做

### 8.1 對病患（尤其長輩）

台灣的現況數字：**65 歲以上約三成有多重用藥**，且**超過一半的長者同時使用 5 種以上藥品**；研究指出**四成到七成五的長者無法在正確時間、以正確劑量服藥**，另有調查稱「十位長者有五位未按醫囑按時服藥」。認知功能退化、視力、藥品種類多、服藥時程複雜，是直接原因。

MedSafe 已經解決了「跨院用藥沒人看得到全貌」——但**解答目前只存在於一個長輩不會打開的網頁裡**。LINE 整合要解的不是技術問題，是**觸達問題**：把已經算出來的答案，送到長輩真的會看的地方。

### 8.2 對醫師

`adherenceLog` 目前只有病患自己在網頁上勾才會有資料——實際上幾乎不會有人勾。LINE 一鍵回報會讓這份資料**第一次真的長出來**，醫師端才有「這位病患的降血壓藥這個月只吃了六成」這種可回診時討論的東西。

（同時要誠實：這是病患自述，不是系統驗證。見 §6.3。）

### 8.3 對競賽敘事（GCA 金源獎 · 生活健康教育組）

「生活健康教育」這個組別，評的不是技術有多難，是**衛教訊息有沒有真的抵達目標族群**。目前的 MedSafe 是一個做得很紮實、但需要「長輩會開電腦、會登入」的系統。LINE 整合把這個假設拿掉了。

三個可以直接寫進簡報的句子：

1. **「我們不是做了一個 LINE 掛號，我們讓掛號變成一次有期限、可撤銷、留痕的資料授權。」**
2. **「跨院交互作用的警示，第一次是在它發生的當下、送到病患本人的手機上，而不是等他下次回診。」**
3. **「為了進 LINE，我們沒有在安全邊界上開任何一個洞——LIFF 裡的每一次讀取，走的還是同一份 `firestore.rules`。」**

第三句尤其重要：本專案的差異化一直是「安全稽核做得比同齡專案深」（`04_Security_Audit/` 整個資料夾）。LINE 整合最容易毀掉這個賣點（多數團隊會直接用 Admin SDK 把資料撈出來丟進聊天室），而 §2 的 Custom Token 設計讓它反而**強化**了那個賣點。

### 8.4 誠實的競爭定位

不要宣稱「首創 LINE 醫療服務」。台灣醫院的 LINE 掛號、看診進度、領藥提醒都已經很成熟，健保署官方帳號也有掛號導引。**MedSafe 在 LINE 上唯一沒有人做的事，是「跨院」**——單一醫院的 LINE 官方帳號結構上不可能告訴你，你在別家醫院拿的藥和這家的會出事。這才是站得住腳的定位。

---

## 9. 建議範圍與時程

**今天 2026-09-09，投稿目標 9/22–9/25（硬期限 9/30 17:00，送出後鎖定且會與展示影片比對一致性）。**
剩餘工作還包括家屬共照、簡報文案、16:9 主視覺、3 張截圖、≤3 分鐘影片。**LINE 三個功能全做完會擠掉影片時間，這是最大的風險。**

分階段，每一階段結束都是一個可以獨立展示的完整狀態：

| 階段 | 內容 | 估時 | 沒做完的話 |
|---|---|---|---|
| **P0** | Functions 骨架 + 綁定流程 + 三個 collection 的規則與測試 + `patient.html` 綁定卡片 | 0.5–1 天 | 什麼都不能做，這是地基 |
| **P1** ⭐ | **新處方 DDI 警示即時推播** + 每日彙整卡 + 一鍵回報 postback | 1 天 | **只做到 P1 就足以錄一支好影片** |
| **P2** | 身分橋接（Custom Token）+ LIFF 數位藥箱 + 圖文選單（含現成的 check/schedule 兩格） | 1–1.5 天 | 藥箱仍可用 Flex 摘要卡（免費那層）替代 |
| **P3** | LIFF 掛號 + 回診提醒 | 0.5 天 | 掛號留在網頁版，不影響主線敘事 |
| **P4** | 「通知家人」單向遵從狀態推播 | 0.5 天 | 純加分 |

**如果只能做一件事：做 P0 + P1。** 新處方交互作用即時推播是三個功能裡唯一「別人做不到」的那個，而且它最好錄影——按下開藥，手機當場響。掛號和藥箱雖然更完整，但都是「已經有人做過的東西做得比較好」。

**時程建議**：9/10–9/13 做 P0+P1，9/14–9/16 視進度做 P2，**9/17 起一律不再加功能**，全部投入影片與簡報。

---

## 10. 你需要決定 / 提供的事項

1. **LINE Developers 帳號與 Messaging API channel** — 免費，但必須由你用自己的 LINE 帳號建立，我無法代辦。需要 Channel ID / Channel Secret / Channel Access Token（長期）。要的話我可以給逐步申請指引。
   - 順帶：**LIFF 也要在同一個 Provider 下建立 LINE Login channel 並註冊 LIFF app**（`liff.init` 需要 LIFF ID）。做 P2/P3 才需要。
2. **Firebase 是否升 Blaze**？Cloud Functions 的前提。預期帳單為 0，但要綁卡。專案先前為了降低攻擊面把自架 FHIR 砍掉，所以這裡明確跟你確認，不預設。
3. **範圍**：確認上面的 P0–P4 要做到哪一階段。（建議：P0+P1 保底，P2 有餘力再做。）
4. **推播頻率**：每時段一則 vs **每日一張彙整卡**（建議後者，成本降 2/3、干擾降 2/3、功能不減）。
5. **隱私模式預設值**：訊息裡**要不要**出現藥名？（我傾向預設「顯示」但綁定時明確告知並可關閉——長輩看得到藥名，提醒才真的有用；但這是你的價值判斷，不是技術判斷。）
6. **官方帳號品牌**：顯示名稱、大頭貼、圖文選單視覺——投稿影片會露出，建議先想好。
7. **綁定對象**：確認這次只做病患本人（家屬僅做 §6.2 的單向狀態通知），不碰完整共照模式。

---

## 11. 實作步驟（確認後）

1. `firebase init functions`（Node.js 2nd gen），`.gitignore` / `firebase.json` 補設定（**注意 `hosting.public` 是 `.`，新增的內部檔案務必同步加進 `ignore` 清單**——本檔案 `linebot.md` 已在清單內）。
2. `firebase functions:secrets:set LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN`。
3. `firestore.rules` 新增 `line_link_codes` / `line_bindings` / `line_users` / `line_push_log`，補 `tests/firestore-rules.test.mjs`，跑 `npm run test:rules`。
4. `functions/`：`lineWebhook`（簽章驗證、綁定、postback 回報）、`lineExchangeToken`（ID Token → Custom Token）、`onPrescriptionAdded`（Firestore 觸發，DDI 警示推播）、`dailyReminderPush`（Scheduler，`Asia/Taipei`）。
5. `patient.html` 新增「LINE 提醒」卡片：綁定碼 + QR、綁定狀態、隱私模式開關、解除綁定、測試推播按鈕。
6. LIFF 頁面（P2/P3）：`liff-medbox.html`、`liff-appointment.html`。
7. `firebase deploy --only functions,firestore:rules,hosting`（**規則與 hosting 必須一起部署**，見 `DEPLOY_CHECKLIST.md` §2）。
8. 用**真實 LINE 帳號**跑完整流程驗證，不是看程式碼就當完成。

## 12. 驗證方式

- `npm run test:rules` 涵蓋四個新 collection 的存取控制（特別要測：**病患不能讀別人的 `line_link_codes`、不能讀任何 `line_users`、不能自行寫 `line_bindings`**）。
- 端對端：登入病患 → 產生綁定碼 → 真實 LINE 傳碼 → 確認 `line_bindings` 與 `line_users` 都寫入 → 醫師端開一個會產生 major DDI 的處方 → 確認手機當場收到警示 → 按「我吃了」→ 確認 `adherenceLog` 當天 `taken` 多一筆，且**日期是台北時間的今天**。
- 冪等測試：手動連續觸發 `dailyReminderPush` 兩次，確認只推一則。
- 時區測試：把測試時間設在台北時間 00:30 與 07:30，確認 `dayKey` 都落在正確的一天。
- `firebase functions:log` 確認簽章驗證、token 交換、推播呼叫沒有錯誤。

---

## 附錄：資料來源

- [2026年 LINE 官方帳號方案價格調整｜LINE Biz-Solutions](https://tw.linebiz.com/column/LINEOA-2026-Price-Plan/) — 方案月費、免費則數、免費訊息類型定義
- [Messaging API 介紹 | LINE Developers](https://developers.line.biz/zh-hant/docs/messaging-api/overview/) — Push / Reply 差異
- [Using user data in LIFF apps and servers | LINE Developers](https://developers.line.biz/en/docs/liff/using-user-profile/) — 「不可把前端取得的 userId 直接送到後端，必須送 ID Token 由伺服器驗證」
- [Get profile information from ID tokens | LINE Developers](https://developers.line.biz/en/docs/line-login/verify-id-token/) — `POST /oauth2/v2.1/verify`
- [LINE Notify 3月底終止服務｜數位時代](https://www.bnext.com.tw/article/80785/line-notify-2025-end-of-service) — **LINE Notify 已於 2025/3/31 終止，網路上大量教學已失效，必須用 Messaging API**
- [慈濟醫院 LINE 官方帳號案例｜LINE Biz-Solutions](https://tw.linebiz.com/case-study/tzu-chi/) — 準時報到率 +11.7%、掛號使用率 +44%、滿意度 82%
- [健保署 LINE 官方帳號升級 預約掛號嘛也通｜衛生福利部](https://www.mohw.gov.tw/cp-5264-65882-1.html) — 健保署既有掛號導引服務（新聞稿數據年份較早，引用時勿宣稱為現況）
- [台灣高齡者多重用藥率增10%｜健康醫療網](https://www.healthnews.com.tw/article/62328) — 多重用藥盛行率
- [認識高齡長者用藥安全｜臺中榮民總醫院](https://ihealth.vghtc.gov.tw/media/734) — 服藥遵從性 40%~75%
- [守護高齡長輩用藥安全的三大護身符｜國家衛生研究院](https://ageing.nhri.edu.tw/) — 多重用藥與跌倒、住院風險
