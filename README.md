# MedSafe — 跨院用藥衝突偵測系統

MedSafe 是一個為 **2026 LINE AI 創新創業競賽** 開發的跨醫療機構用藥衝突偵測系統。

## 快速開始

### 系統要求
- Node.js 18+ （用於測試和工具）
- Python 3.7+ 或 `npx serve` （用於本地開發伺服器）
- Firebase CLI （用於 Firestore 模擬器測試）

### 本地執行
```bash
# 安裝依賴（測試/工具）
npm install

# 執行測試套件
npm test

# 啟動本地開發伺服器
python -m http.server 8000
# 或
npx serve .
```

訪問 `http://localhost:8000` → 自動重定向至登入頁面

## 專案結構

```
.
├── CLAUDE.md                  # Claude Code 開發指南（重要！）
├── DEPLOY_CHECKLIST.md        # 部署前檢查清單
├── js/                        # 前端邏輯（全域作用域，無打包工具）
│   ├── drug-catalog.js        # 藥物身份解析
│   ├── ddi-engine.js          # 交互作用偵測引擎
│   ├── ddi-rules-ddinter.js   # DDInter 規則資料（自動生成）
│   ├── auth.js                # 身份驗證與授權
│   └── ...
├── tests/                     # Node 測試套件（.mjs 模組）
│   ├── ddi-engine.test.mjs
│   ├── firestore-rules.test.mjs
│   └── ...
├── functions/                 # Cloud Functions（伺服器端邏輯 + LINE 整合）
│   ├── src/bindings.js        # LINE 綁定流程
│   ├── src/llm.js             # LLM 藥物識別
│   └── ...
├── firestore.rules            # Firestore 安全規則（最關鍵的存取控制）
├── *.html                      # 四個角色入口（patient/dashboard/admin/insurance）
└── ...
```

## 重要文檔

| 文檔 | 用途 |
|------|------|
| **[CLAUDE.md](CLAUDE.md)** | Claude Code 開發與架構指南（編碼前必讀） |
| **[DEPLOY_CHECKLIST.md](DEPLOY_CHECKLIST.md)** | 部署前完整檢查清單（已編入實際事故的教訓） |
| **[../../ATTRIBUTION.md](../../ATTRIBUTION.md)** | **授權聲明與資料來源（CC BY-NC-SA 4.0）** |
| **[../../04_Security_Audit/MedSafe_系統稽核報告.md](../../04_Security_Audit/MedSafe_系統稽核報告.md)** | 完整的對抗性安全稽核報告 |

## 授權與資料來源

### 🔴 重要
本專案使用 **DDInter 2.0** 藥物交互作用資料庫（中南大學/國防科技大學開發）。

**授權條款**: CC BY-NC-SA 4.0（非商業性使用）

**完整聲明請見**: [ATTRIBUTION.md](../../ATTRIBUTION.md)

### 使用限制
- ✅ **允許**: 非商業用途、教育、競賽、醫療研究
- ❌ **不允許**: 商業化部署（需另行取得商業授權）
- ✅ **衍生開發**: 必須採用相同 CC BY-NC-SA 4.0 授權條款

## 核心系統

### 藥物交互作用（DDI）偵測
- **資料源**: DDInter 2.0（1,565 條規則）+ 人工維護規則（5 條）
- **匹配方式**: 藥物 ATC 碼（非名稱字串比對）
- **嚴重度**: 5 級（主要/重度/中度/輕微/未知）
- **測試覆蓋**: 67/67 用例通過

### 四角色入口
| 角色 | 入口 | 功能 |
|------|------|------|
| **患者** | `patient.html` | 檢視用藥清單、交互作用警示、掛號 |
| **醫師** | `dashboard.html` | 管理患者、處方簽、DDI 檢查 |
| **管理員** | `admin.html` | 帳號管理、系統設定、規則維護 |
| **保險** | `insurance.html` | 交叉統計、費用分析（演示版） |

### 資安設計
- **信任邊界**: Firestore 安全規則是唯一的存取控制（前端完全公開）
- **身份驗證**: Firebase Auth（username/password）
- **授權**: Firestore 規則決策 + Cloud Functions 二次驗證
- **敏感欄位**: write-once 模式、可追溯的變更記錄

詳見 [CLAUDE.md](CLAUDE.md) 的存取控制模式章節。

## 開發工作流

### 規則或藥物目錄變更
**任何 DDI 規則或藥物身份邏輯的改動都必須**：
1. 修改對應的源檔 (`js/drug-catalog.js`, `js/ddi-engine.js`, 或人工規則)
2. 執行測試: `npm run test:ddi` 或 `npm run test:catalog`
3. 所有測試通過後才考慮變更完成

### Firestore 規則變更
```bash
# 測試規則（需 Firestore 模擬器）
npm run test:rules

# 驗證規則正確後才部署
firebase deploy --only firestore:rules,hosting
```

### 部署
```bash
# 完整部署前檢查
cat DEPLOY_CHECKLIST.md

# 部署規則 + 應用
firebase deploy --only firestore:rules,hosting
```

**警告**: 規則和程式碼必須成對部署，否則會靜默功能損壞。

## 已知限制與設計選擇

### 臨床
- **DDI 引擎使用開源資料庫** — 非藥師級決策系統，應配合臨床專業判斷
- **交互作用覆蓋率** — 0.67%（因藥物目錄規模小），見 [稽核報告](../../04_Security_Audit/MedSafe_系統稽核報告.md)
- **未設自動停藥** — 評估是否停用由醫師決策（非系統自動化）

### 技術
- **無打包工具** — 純 HTML + 全域作用域 JS（簡化部署，便於審查）
- **無公開 DDInter API** — 改採離線匯入（CSV→JS 規則）
- **靜態部署** — 前端完全公開，所有安全性靠後端規則

### 安全性
- **6 項 P0 阻斷級缺陷已修復**（見稽核報告第一章）
- **13 項 P1 高風險** — 12 項已修復，餘 P1-6 待 Phase 6 處理
- **建議正式部署前再做一次滲透測試**

詳見完整稽核報告：[MedSafe_系統稽核報告.md](../../04_Security_Audit/MedSafe_系統稽核報告.md)

## 測試

```bash
# 完整測試套件
npm test

# 個別測試
npm run test:catalog    # 藥物身份解析
npm run test:ddi        # 交互作用偵測
npm run test:fhir       # FHIR 客戶端
npm run test:nlu        # LINE 語意理解
npm run test:webhook    # LINE webhook 簽名
npm run test:rules      # Firestore 規則（需模擬器）
```

## 競賽資訊

- **競賽**: 2026 年 LINE AI 創新創業競賽
- **主題**: 智慧照護 × 用藥衝突偵測
- **決選日期**: 2026 年 10 月 16 日
- **決選地點**: 國立臺中科技大學

## 聯繫方式

- **開發團隊**: [MedSafe 團隊]
- **聯絡信箱**: william40510@gmail.com
- **競賽官方**: [2026 LINE AI 創新創業競賽](https://campaign.line.me/zh-hant/campaign/innovation2026/)

---

## 授權聲明

本專案使用 **DDInter 2.0** 資料庫，遵循 **CC BY-NC-SA 4.0** 授權條款。

**詳見**: [ATTRIBUTION.md](../../ATTRIBUTION.md)

**最後更新**: 2026-09-16
