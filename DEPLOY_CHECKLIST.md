# 部署前檢查清單

**建立日期**：2026-09-02
**適用版本**：commit `b2e1203` 之後
**線上專案**：`medsafe-554b7` → https://medsafe-554b7.web.app

---

## 為什麼需要這份清單

線上網站目前是 **Phase 1 之前的舊碼**。這中間累積的改動包含四個新集合、
一套會拒絕舊寫法的安全規則，以及從未部署過的整個 PWA 層。

**這不是一次尋常的部署**：規則與程式碼互相依賴，只部署一邊會讓功能壞掉，
而且壞的方式不明顯——不會有錯誤畫面，只會有某些操作靜默失敗。

---

## 一、部署前必須先確認（做完才能按 deploy）

### 1.1　確認要部署的是正確的 commit

```bash
git log --oneline -1        # 應為 b2e1203 或更新
git status --porcelain      # 應為空
```

未提交的改動不會被 `firebase deploy` 排除——`hosting.public` 是 `.`，
**工作目錄中的任何檔案都會被上傳**，包含你臨時改壞還沒還原的那些。

### 1.2　三套測試全綠

```bash
npm run test:catalog     # 35 項
npm run test:ddi         # 45 項
npm run test:rules       # 83 項（需要 firebase emulators）
```

`test:rules` 驗的是**即將被部署的那一份** `firestore.rules`。這一項失敗代表
規則有洞或會誤擋合法操作，**不可部署**。

### 1.3　確認部署範圍沒有夾帶不該公開的檔案

`hosting.public` 是 `.`（專案根目錄），**預設會上傳整個資料夾**，
只靠 `firebase.json` 的 `ignore` 清單排除。本次已補上以下排除項，
若你新增了其他內部檔案，記得一併加入：

| 排除項 | 原因 |
|---|---|
| `DEPLOY_CHECKLIST.md` | 就是這份文件。寫著系統的已知限制與取捨，不該放在公開網址 |
| `*.log` / `firestore-debug.log` | 模擬器除錯日誌（本機那份 174 KB），內容不受控 |
| `*.bak` | 規則備份檔（見第六節），內含完整的安全規則 |
| `node_modules/**` | 89 MB，且與網站無關 |
| `progress-dashboard.html` | 內部開發進度頁 |
| `tests/**` | 測試碼會揭露攻擊腳本與規則細節 |

部署後務必實測這幾條真的生效：

```bash
BASE=https://medsafe-554b7.web.app
for f in DEPLOY_CHECKLIST.md README.md progress-dashboard.html          firestore.rules package.json tests/firestore-rules.test.mjs          firestore-debug.log node_modules/vue/package.json; do
  printf "%-40s %s
" "$f" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$f")"
done
```

**全部要是 404。** 任何一個回 200 代表該檔案已經公開了。

### 1.4　確認沒有機敏資料進入部署範圍

```bash
grep -rn "apiKey\|password\|secret\|token" --include=*.js --include=*.json . \
  | grep -v node_modules | grep -v "js/firebase-config.js"
```

`js/firebase-config.js` 中的 Firebase 設定是**設計上公開**的（存取控制靠
Security Rules，不靠隱藏設定），不需處理。其餘任何命中都要逐一確認。

---

## 二、部署順序（這一節最重要）

### 規則與程式碼必須一起部署

兩者互相依賴，**單獨部署任何一邊都會壞**：

| 只部署 | 會發生什麼 |
|---|---|
| 只部署 hosting（新程式 + 舊規則） | 新程式會寫入 `consents`、`patient_summaries`、`conversations`、`audit_logs`——舊規則沒有這些集合，一律 **default deny**。授權、對話、稽核三個功能全部靜默失敗 |
| 只部署 rules（舊程式 + 新規則） | 新規則要求新增用藥必須攜帶 `safetyCheck`。線上的舊程式不會寫這個欄位，**醫師開立處方會被資料層拒絕** |

正確做法是一道指令同時送出：

```bash
firebase deploy --only firestore:rules,hosting
```

> 注意：Firebase 不保證兩者原子性生效，中間會有數秒的不一致窗口。
> 選在沒有人使用的時段執行即可，不需要特別處理。

### 若 `firebase deploy --only firestore` 報錯

`firebase.json` 只宣告了 `firestore.rules`，沒有 `firestore.indexes.json`
（該檔案不存在）。用 `firestore:rules` 這個子目標可避開索引部署。

本次新增的三個查詢都是**單欄位查詢**，Firestore 會自動建索引，不需要複合索引：

- `consents` → `where('insurer', '==', ...)`
- `conversations` → `where('participants', 'array-contains', ...)`
- `audit_logs` → `orderBy('at', 'desc')`

---

## 三、部署後立即驗證（每一項都要親手點過）

### 3.1　靜態檔案確實上去了

整個 PWA 層**從未部署過**，線上目前全部 404。部署後應全為 200：

```bash
BASE=https://medsafe-554b7.web.app
for f in manifest.json service-worker.js js/pwa-register.js \
         icons/icon-192.png icons/apple-touch-icon.png \
         js/drug-catalog.js js/ddi-engine.js js/audit.js js/fhir-client.js; do
  printf "%-28s %s\n" "$f" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$f")"
done
```

**全部要是 200。** 任何一個 404 代表 `firebase.json` 的 `ignore` 把它排除掉了。

### 3.2　四個角色各登入一次

用無痕視窗，避免讀到你自己的舊登入狀態（這會讓你以為首頁就是管理後台）。

| 角色 | 帳號 | 進去後必須確認 |
|---|---|---|
| 病患 | `patient01` | 首頁摘要指的是**華法林與阿斯匹靈**；綜合維他命標示為「風險」或「待確認」，**不可是「安全」**；回診日期不是過去的日期 |
| 醫師 | `doctor` | 病患清單有人；開立處方時**未執行檢測不得送出**；偵測到風險時要求填寫覆蓋理由 |
| 核保 | `insurance01` | 見下方 3.4，這一項預期會是空的 |
| 管理 | `admin` | 系統設定頁的 FHIR Base URL 欄位沒有「規劃中」字樣；Access Key 欄位已消失 |

### 3.3　開一次瀏覽器主控台，確認沒有紅字

特別注意 `permission-denied`——那代表某個新集合的規則沒生效。

### 3.4　核保端會是空的，這是預期行為（但要處理）

P1-6 修復後，核保端**不再能讀取任何病歷**，改為只讀「已授權本公司」的核保摘要。
Firestore 中目前**沒有任何 `consents` 文件**，所以核保端會顯示：

> 目前沒有病患授權本公司查閱核保摘要

功能上正確，但**評審看到的是一個空白頁面**，會判讀成「這個角色沒做完」。

**處理方式（擇一）**：

- **(A) 現場示範授權流程**（推薦）：在展示影片中，先用 `patient01` 到「資料授權」
  區塊授權給 `insurance01`，再切換到核保端顯示資料出現。
  這反而把「病患掌握自己的資料」這個賣點演出來了，比一開始就有資料更有說服力。
- **(B) 事先種入**：以 `patient01` 登入 → 資料授權 → 輸入 `insurance01` → 授權。
  重複幾位病患即可。**不要用 Firebase Console 手動塞** `consents` 文件——
  規則要求 `grantedAt == request.time`，手動建立的文件時間戳不會通過後續檢查。

### 3.5　醫病對話會從零開始

對話已從 localStorage 遷移到 Firestore（P1-4），**既有的聊天紀錄不會被搬移**。
醫師端「訊息中心」在部署後是空的。若要在展示中呈現對話功能，
請以 `patient01` 送一則訊息、`doctor` 回一則，即可建立一串。

---

## 四、Firestore 既有資料需要處理的欄位

程式碼已不再依賴以下欄位，留著無害，但有一個例外**必須處理**：

| 欄位 | 狀態 | 動作 |
|---|---|---|
| `patient_data/*/profile.nextAppointment` | ⚠️ **仍會被讀取** | 值為 `2026-09-01`，已過期。畫面會誠實顯示「回診日 2026-09-01 已過期」——正確但不好看。**建議刪除此欄位**，讓程式改走「距今天數」的示範值 |
| `patient_data/*/medications[].status` / `.color` / `.icon` | 已不讀取 | 可留著，安全標示改由引擎即時計算 |
| `patient_data/*/profile.healthSummary` | 已不讀取 | 可留著，摘要改由引擎產生 |
| `patient_data/*/aiInsights` | 已不讀取 | 可留著 |
| `patient_data/*/stats.safetyScore` | 已不讀取 | 可留著，改為即時計算 |
| `patient_data/*/assignedDoctor` | ⚠️ **必須存在** | 決定誰能讀該病患的對話（`conversations.participants`）。未設定的病患，醫師看不到其對話 |

---

## 五、已知且刻意不修的事項（先想好怎麼回答）

評審或觀眾若問起，以下是已知的取捨，不是疏漏：

| 項目 | 現況與理由 |
|---|---|
| 展示帳號密碼寫在前端 | 純前端專案可被完整下載，等同公開發佈。已排除最高權限的 `admin` 自動填入。大賽規章明文允許提供「大眾試用帳號」，此為展示所需 |
| 資料仍上傳至 `hapi.fhir.org` | HL7 公開沙箱，全球可讀寫。已做去識別化（隨機化名、模糊出生年、不送姓名），且畫面上有明確警告。Base URL 現已可設定，換成自架伺服器只需改一個欄位 |
| 任何醫師可讀任何病歷 | 尚未實作醫病關係驗證。若只用 `assignedDoctor` 等值比對，**代班與會診醫師會被鎖在門外，急診情境下會致命**。正確做法需要轉診授權模型 |
| 稽核記錄無法保證「每個動作都被記錄」 | 記錄由前端寫入，惡意呼叫端不呼叫就沒有記錄。已保證的是不可竄改、不可冒名、不可偽造時序。要達成必然留痕需後端 trigger |
| 核保摘要是病患自述 | 系統無法驗證其真實性，畫面已明白標示。要做到必然忠實需後端在病歷變更時自動重算 |

---

## 六、回滾

若部署後發現嚴重問題：

```bash
firebase hosting:rollback           # 回到前一版 hosting
```

**但 Firestore 規則沒有等價的回滾指令。** 規則需要用舊版檔案重新部署：

```bash
git stash                                    # 或 git checkout <舊 commit> -- firestore.rules
firebase deploy --only firestore:rules
```

因此**部署前先把當前線上的規則抓下來留底**：

```bash
firebase firestore:rules:get > firestore.rules.deployed.bak
```

> 注意回滾的方向性：hosting 回舊版但規則留在新版，會讓舊程式碼寫入被新規則拒絕
> （見第二節）。**要回滾就兩個一起回。**

---

## 七、最後一次確認（按下 deploy 之前）

- [ ] `git status` 乾淨，commit 正確
- [ ] 三套測試全綠（35 + 45 + 83 = 163）
- [ ] 已備份線上規則（`firestore.rules.deployed.bak`）
- [ ] 確認使用 `--only firestore:rules,hosting`（兩者一起）
- [ ] 部署後：9 個應公開的檔案全為 200
- [ ] 部署後：8 個不該公開的檔案全為 404（含 `DEPLOY_CHECKLIST.md`、`tests/`、`node_modules/`）
- [ ] 部署後：四個角色各以**無痕視窗**登入一次
- [ ] 部署後：主控台無 `permission-denied`
- [ ] 部署後：`patient01` 首頁的綜合維他命**不是**綠色的「安全」
- [ ] 已決定核保端空白頁的處理方式（現場示範授權 or 事先種入）
- [ ] 已刪除或更新 Firestore 中過期的 `nextAppointment`
