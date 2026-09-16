# 部署前檢查清單 (DEPLOY_CHECKLIST)

**部署日期**: ___________  
**部署者**: ___________  
**複核者**: ___________

---

## 📋 部署前必檢項

### 1️⃣ 規則與程式碼配對檢查

**風險**: Firestore 規則和前端程式碼版本不符會導致靜默功能損壞。

- [ ] 確認 `firestore.rules` 最新版本
- [ ] 確認所有程式碼變更已測試通過（`npm test`）
- [ ] 確認未修改 Firestore 集合 schema 而規則未更新
  - 若修改 schema，必須 **同時更新規則**
  - 舊規則拒絕新資料格式 → 靜默寫入失敗
  - 新規則拒絕舊資料格式 → 舊用戶端無法讀取

### 2️⃣ 敏感組態檔案檢查

**風險**: `.git/`、`node_modules/`、`.env` 等不應被上傳。

- [ ] 檢查 `firebase.json` 的 `hosting.ignore` 清單
  - 確認至少包含:
    ```json
    "ignore": [
      ".git/**",
      ".gitignore",
      "node_modules/**",
      ".env",
      ".env.local",
      "package-lock.json",
      "README.md",  // 可選
      "DEPLOY_CHECKLIST.md",  // 不上傳
      "tests/**",
      "tools/**",
      "functions/src/**",
      ".claude/**",
      ".thumbs/**"
    ]
    ```
- [ ] 檢查是否有新添加的敏感檔案未列入 ignore
  - 特別注意: 隱藏檔 `**/.*` 只排除根層，`.git/` 內的檔案需 `.git/**`
- [ ] 確認 `js/firebase-config.js` 的 API key 是公開的（web app 必然）
- [ ] 確認 `js/mockData.js` 的示範帳號只在 `demo=1` 時顯示（已修復 P0-2）

### 3️⃣ DDInter 資料庫授權檢查 ⚠️ **關鍵**

**授權條款**: CC BY-NC-SA 4.0（非商業性使用，需標示原著作者）

#### 部署前確認項
- [ ] 已建立 `ATTRIBUTION.md` 並放在專案根目錄
  - 文件應明確標示 DDInter 來源與授權條款
  - 見: `D:/競賽/GCA/ATTRIBUTION.md`
- [ ] README（源代碼目錄）已引用 ATTRIBUTION.md
  - 見: `Source_Code/Security-main/README.md`
- [ ] 前端入口頁面 (login.html 或 about.html) 有授權聲明連結
  - 建議於頁尾或首次登入時展示

#### 部署環境檢查
- [ ] **非商業環境確認**
  - ✅ 競賽演示: CC BY-NC-SA 4.0 適用
  - ❌ 正式醫療機構部署: 需商業授權（DrugBank/Lexicomp/Micromedex）
  - ❌ 付費 SaaS: 違反非商業條款

#### 若進行商業化部署，必須
- [ ] 取得 DDInter 官方商業授權 **或** 
- [ ] 轉換至商業資料庫（DrugBank Professional / Lexicomp / Micromedex）
- [ ] 相應更新 `tools/import-*.mjs` 與規則匯入邏輯
- [ ] 更新所有授權聲明與文檔

### 4️⃣ Cloud Functions 部署檢查

- [ ] `functions/` 已初始化並通過測試
- [ ] 環境變數已配置（LINE Channel ID, Access Token 等）
  ```bash
  firebase functions:config:set line.channel_id="..." line.access_token="..."
  ```
- [ ] `functions/vendor/` 目錄已由 `sync-vendor.js` 自動生成
  - [ ] `js/ddi-rules-ddinter.js` 已同步到 `functions/vendor/`
  - [ ] DDI 引擎的兩份實裝完全一致（前端 + Cloud Functions）
- [ ] `functions/predeploy` 已執行（自動在 `firebase deploy` 時執行）

### 5️⃣ Firebase 配置檢查

#### Firestore
- [ ] 資料庫位置已設定為 `asia-east1`
- [ ] 索引配置已上傳（若有自訂索引）
  ```bash
  firebase deploy --only firestore:indexes
  ```

#### 安全規則
- [ ] `firestore.rules` 已完整複查
  - 特別注意標記為 `P0-`, `P1-`, `S-1`, `S-2`, `H-x` 的已知風險
  - 見文件內嵌註解說明歷史漏洞
- [ ] 規則測試已全部通過
  ```bash
  npm run test:rules
  ```
- [ ] 未有待辦變更（如承諾但未實作的規則片段）

#### Authentication
- [ ] Firebase Auth 已啟用 Email/Password 登入
- [ ] 未意外啟用社交登入（OAuth）
  - 若後續需要 LINE Login，見 `functions/src/exchange.js` 的 LIFF 整合

#### Hosting
- [ ] 部署的公開目錄確認為 `.` (專案根)
- [ ] SSL/TLS 已啟用（Firebase Hosting 自動）
- [ ] Cache-Control 設定已檢查
  ```json
  {
    "headers": [
      {
        "source": "**/*.html",
        "headers": [
          {
            "key": "Cache-Control",
            "value": "public, max-age=0, must-revalidate"
          }
        ]
      },
      {
        "source": "js/**",
        "headers": [
          {
            "key": "Cache-Control",
            "value": "public, max-age=3600"
          }
        ]
      }
    ]
  }
  ```
  - HTML 無快取，避免 deploy 後舊程式碼被服務
  - JS 可快 1 小時（版本更新時手動清除 CDN 快取）

### 6️⃣ 安全性檢查

#### 已知風險（已修復）
- [ ] P0-1 (權限提升): `isSelfRegisteringPatient()` 已驗證 username
- [ ] P0-2 (硬編密碼): 示範帳號已與正式分離，密碼不公開展示
- [ ] P0-3 (虛偽 DDI 引擎): 規則庫已由 2 條→1,691 條，查無結果時顯示「尚未評估」
- [ ] 其他 P0/P1 缺陷已按稽核報告修復

#### 安全性建議
- [ ] 建議正式上線前執行第三方滲透測試
- [ ] 建議設定 Content-Security-Policy (CSP) header
- [ ] 建議啟用 HTTPS-only 模式

### 7️⃣ 資料遷移檢查（如適用）

- [ ] 若有舊系統資料需遷移，已備份原始資料
- [ ] 資料遷移指令碼已測試（沙箱環境）
- [ ] 遷移後資料完整性已驗證
- [ ] 舊系統已計畫下線時間

### 8️⃣ LINE 整合檢查（若部署到正式）

- [ ] LINE Official Account 已設定（`LINE_BASIC_ID` = OA 的 Channel ID）
- [ ] LINE Channel Secret 已配置到 Cloud Functions
- [ ] LINE Access Token 已配置到 Cloud Functions
- [ ] Webhook URL 已設定為 `https://your-domain/functions/webhook`
- [ ] Webhook 簽名驗證已測試
  ```bash
  npm run test:webhook
  ```
- [ ] 若使用 LIFF，LINE Login Channel 已建立
  - [ ] `LINE_LOGIN_CHANNEL_ID` 已配置
  - [ ] LIFF App ID 已配置到 `js/line-liff-config.js`
  - [ ] LIFF 身份交換已測試
    ```bash
    npm run test:exchange
    ```

### 9️⃣ 部署執行

```bash
# 最終檢查
firebase projects:list
firebase deploy --dry-run

# 部署規則 + 應用（成對部署！）
firebase deploy --only firestore:rules,hosting

# 或包含 Cloud Functions
firebase deploy --only firestore:rules,hosting,functions
```

- [ ] 部署指令已執行
- [ ] Firebase Console 顯示部署成功
- [ ] 無部署錯誤或警告（除非是已知的、已記錄的例外）

### 🔟 部署後驗證

#### 功能測試
- [ ] 訪問 `https://your-domain/login.html`
- [ ] 示範帳號可正常登入（如有）
- [ ] 患者端: 能顯示用藥清單
- [ ] 醫師端: 能查詢患者、新增處方、檢查 DDI
- [ ] 管理端: 能管理帳號、修改系統設定
- [ ] 交互作用警示能正確觸發
- [ ] DDI 規則計數器顯示正確（1,691 條）

#### 安全性驗證
- [ ] Firestore 規則已上傳（可在 Firebase Console 確認）
- [ ] 未授權用戶無法直接存取 Firestore
- [ ] 患者無法讀取他人病歷
- [ ] 非管理員無法修改系統設定

#### 日誌與監控
- [ ] Firebase Console 的 Activity Log 無異常
- [ ] Cloud Functions 執行日誌無錯誤
  ```bash
  firebase functions:log
  ```
- [ ] 若配置了 Google Analytics 或 Sentry，驗證事件正確上傳

#### DDI 規則驗證
- [ ] 確認從 DDInter 匯入的 1,565 條規則已生效
- [ ] 測試已知交互作用（如 Warfarin + NSAIDs）能正確偵測
- [ ] 測試不存在的交互作用返回「查無記載」而非「安全」

---

## ⚠️ 已知風險與限制

### 臨床
- **DDI 引擎涵蓋率僅 0.67%**
  - 因藥物目錄規模小（60 種藥物 vs DDInter 的 2,300 種）
  - 對患者說「查無記載 ≠ 安全」，建議另詢醫師或藥師
  - 見完整稽核報告第 V 章

### 技術
- **無公開 DDInter API**
  - 需定期手動更新 CSV 資料（目前為一次性 2026-09-03 的匯入）
  - 未來若有新版 DDInter，需重新執行 `import-ddinter.mjs`

- **靜態部署意味著 audit logs 無法保證完整**
  - 患者可不透過系統修改本地資料
  - UI-only audit trail 不夠可信
  - 建議搭配 Firestore 審計日誌（GCP 付費功能）

### 安全
- **2026-09-03 安全稽核後仍有 1 項 P1 高風險待修**（P1-6, Phase 6)
- **建議正式医療部署前再做滲透測試**

---

## 🔄 部署後監控清單

部署完成後的 **第 1 週**:
- [ ] 日檢查 Cloud Functions 執行日誌
- [ ] 驗證患者/醫師端日常流程可用
- [ ] 監控 Firestore 讀寫配額使用情形

部署完成後的 **第 1 個月**:
- [ ] 蒐集使用者反饋
- [ ] 檢查效能指標（頁面載入時間、Firestore 延遲）
- [ ] 檢查是否有未預期的規則拒絕（Firestore 日誌中的 Permission denied）

---

## 📝 簽核

| 角色 | 名字 | 簽章 | 日期 |
|------|------|------|------|
| 開發者 | | | |
| 複核者 | | | |
| 部署者 | | | |

---

**最後更新**: 2026-09-16  
**版本**: 1.0
