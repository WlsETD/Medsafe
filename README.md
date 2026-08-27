# MedSafe 跨醫院多重用藥衝突與副作用網頁預警系統

## 隊伍資訊
- 隊伍名稱：漂亮北極熊
- 作品名稱：MedSafe 跨醫院多重用藥衝突與副作用網頁預警系統
- 主題領域：醫療資訊 / 長期照護
- 線上展示：https://medsafe-554b7.web.app/
- 原始碼：https://github.com/Yunjia219/Med

---

## 專案簡介
本系統針對台灣高齡化社會中，長輩跨院就醫導致的多重用藥衝突問題，建立一個即時預警平台。系統整合四個使用者端口（病患家屬、醫師、管理員、保險公司），以 Firebase Authentication 與 Firestore 管理身分與資料，並與公用 HAPI FHIR R4 測試伺服器實際介接，完成處方上傳、跨院資料查核與讀回驗證的完整流程。

---

## 系統架構

```text
前端介面 (HTML5 / Vue 3 CDN / Tailwind CSS / ECharts)
        ↕
Firebase Authentication（帳號 → username@medsafe.local 合成 email）
        ↕
Cloud Firestore（角色權限規則 firestore.rules）
        ↕
HAPI FHIR R4 公用測試伺服器 (https://hapi.fhir.org/baseR4)
        ↕
Firebase Hosting（線上部署）
```

- **身分驗證**：使用者輸入帳號密碼後，前端組出 `username@medsafe.local` 的合成 email 交給 Firebase Auth，登入成功後再讀取 `user_roles/{uid}` 取得角色。
- **權限控管**：`firestore.rules` 以 `user_roles/{uid}` 作為唯一可信身分索引，逐一集合定義 admin / doctor / insurance / patient 的讀寫權限；自助註冊只允許建立 `patient` 角色，防止自我提權。
- **即時互動**：`chatStore.js` + `notify.js` 以 localStorage 與 storage 事件實作病患端與醫師端的雙向訊息與未讀通知（分頁標題未讀數、提示音、桌面通知）。

---

## FHIR 實作內容

| 情境 | 頁面 | FHIR 操作 |
|------|------|-----------|
| 病患端雲端同步 | `patient.html` | 以 `Bundle` (type: transaction) 一次寫入 `Patient` (PUT) 與多筆 `MedicationStatement` (POST)，並再次 `GET Patient/{id}` 讀回驗證資料確實存在 |
| 病患確認 DDI 風險 | `patient.html` | `POST Flag`（category: drug-safety）記錄使用者已知悉該交互作用風險 |
| 醫師開立處方 | `dashboard.html` | `POST MedicationRequest`（status: active、intent: order、含 dosageInstruction） |
| 保險核保查核 | `insurance.html` | `GET Patient?name={name}&_count=5`，以回傳 Bundle 的 `total` 驗證跨院資料交換介接是否暢通 |
| 系統設定連線測試 | `admin.html` | 可設定 FHIR Base URL，並以 `GET Patient?_count=1` 測試伺服器連線與延遲 |

實際核心 Resources：**Patient、MedicationRequest、MedicationStatement、Bundle、Flag**。
伺服器端另建立有 Condition、Observation、AllergyIntolerance 等資源，執行結果請見 `02_FHIR_Basic_Implementation/Execution_Screenshots/Hapi Server Resourse/`。

---

## 使用者角色與功能（展示帳號）

| 角色 | 帳號 | 密碼 | 主要功能 |
|------|------|------|----------|
| 病患家屬 / 用戶端 | patient01 | 123456 | 個人用藥清單、DDI 警告與風險確認、用藥提醒、與醫師即時對話、一鍵同步至 FHIR 伺服器 |
| 臨床醫師端 | doctor | 123456 | 病患藥歷管理、ECharts 藥物交互作用關係圖、AI 處方預檢與開立處方並同步 FHIR |
| 系統管理員 | admin | 123456 | 帳號與角色管理、DDI 規則庫維護、系統設定（FHIR Base URL、AI 敏感度）、維護模式 |
| 保險核保員 | insurance01 | 123456 | 理賠與保單管理、風險統計圖表、關懷個案建檔、FHIR Patient 資源查核 |

> 另有 P001～P004 四組病患展示帳號（密碼同為 123456），登入頁亦提供「演示帳號快速登入」按鈕。
> 上述皆為展示用測試帳號，資料為模擬數據，不含任何真實個資。病患可自行於登入頁註冊新帳號（僅能註冊為 patient 角色）。

---

## 如何執行

### 方式一：直接開啟線上展示（建議）
瀏覽 https://medsafe-554b7.web.app/ ，以上表帳號登入即可操作。

### 方式二：本機執行
本專案為靜態網頁，不需要 Node.js 建置流程，但**必須透過 HTTP 伺服器開啟**（Firebase Authentication 不支援 `file://` 協定）：

```bash
cd 02_FHIR_Basic_Implementation/Source_Code/Security-main

# 擇一啟動本機伺服器
python -m http.server 8000
# 或
npx serve .
# 或（已安裝 Firebase CLI）
firebase serve
```

接著在瀏覽器開啟 `http://localhost:8000`，系統會自動導向 `login.html`。
Firebase 專案設定已內含於 `js/firebase-config.js`，可直接連線至既有的 Firestore 資料庫。

---

## 技術特點
1. **真實 FHIR R4 介接**：使用 transaction Bundle 批次寫入、寫入後讀回驗證、以搜尋參數查核跨院紀錄，非僅畫面模擬。
2. **以角色為基礎的資料庫安全規則**：`firestore.rules` 針對每個集合分別定義權限，並防止自助註冊提權；管理員新增帳號時使用獨立的 secondary Auth instance，避免覆蓋當前登入狀態。
3. **ECharts 視覺化**：藥物交互作用關係網狀圖、理賠與風險趨勢圖表、用藥安全分數走勢。
4. **跨分頁即時通訊與通知**：醫病訊息、未讀計數、提示音與瀏覽器桌面通知。
5. **響應式設計**：Tailwind CSS 適配桌面與行動端裝置。
6. **離線降級**：FHIR 或 Firestore 連線失敗時保留本地操作結果並提示使用者，不中斷展示流程。

---

## 專案檔案結構

```text
決賽檔案/
├── 01_Planning_Documents/          # 規劃文件、簡報 prompt、各端版面設計圖
├── 02_FHIR_Basic_Implementation/
│   ├── Data_Specifications/        # MedSafe-Chain 技術規格文件
│   ├── Documentation/              # 專案說明文件、未來可延伸方向
│   ├── Execution_Screenshots/      # 四端執行畫面 + HAPI Server 資源截圖
│   └── Source_Code/Security-main/  # 系統原始碼（見下）
├── 03_Learning_Records/            # 影片學習、AI 互動、業師諮詢紀錄與學習心得
├── github link.txt                 # GitHub 與作品展示連結
└── README.md                       # 本說明文件
```

原始碼結構：

```text
Security-main/
├── index.html               # 載入與角色導向入口
├── login.html               # 登入 / 註冊介面
├── patient.html             # 病患端儀表板
├── dashboard.html           # 醫師端儀表板
├── admin.html               # 系統管理員端
├── insurance.html           # 保險核保端
├── detail.html              # 藥物詳情頁
├── progress-dashboard.html  # 開發進度管理 Dashboard
├── js/
│   ├── firebase-config.js   # Firebase 初始化（含 secondary Auth instance）
│   ├── auth.js              # 登入驗證、角色檢查、登出
│   ├── db-service.js        # Firestore 資料存取層
│   ├── mockData.js          # 展示用模擬數據與 DDI 規則
│   ├── chatStore.js         # 醫病即時訊息（localStorage + storage 事件）
│   ├── notify.js            # 未讀數、提示音、桌面通知
│   └── utils.js             # 共用工具函式
├── images/                  # LOGO 與介面圖片
├── firebase.json            # Firebase Hosting / Firestore 設定
├── firestore.rules          # Firestore 角色權限安全規則
├── README.md                # 專案說明
└── DESIGN_SYSTEM.md         # 設計規範
```
