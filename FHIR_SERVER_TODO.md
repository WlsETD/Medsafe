# FHIR Server 自架部署 — 待處理事項

**建立日期**：2026-09-02
**最後更新**：2026-09-03
**狀態**：Cloud Run 已部署並接上系統。**資料持久化決議暫不處理（方案 C）**；
**存取控制缺口已於 2026-09-03 發現並修正警告呈現**（伺服器本身仍為開放，見第二節）

---

## ✅ 已完成

| 項目 | 內容 |
|---|---|
| Cloud Run 服務 | `medsafe-fhir`，region `asia-east1`，project `gddga-35b16` |
| Service URL | `https://medsafe-fhir-1035204324951.asia-east1.run.app` |
| FHIR Base URL | `https://medsafe-fhir-1035204324951.asia-east1.run.app/fhir` |
| 資源配置 | 2 vCPU / 2Gi 記憶體（512Mi 會因 Spring Boot 啟動吃記憶體而健康檢查失敗） |
| 計費帳戶 | 已連結 `Medsafe`（`010CB6-172CD9-E150BC`）到 `gddga-35b16` |
| 已啟用 API | `run.googleapis.com`、`cloudbuild.googleapis.com`、`artifactregistry.googleapis.com` |
| IAM 修正 | `1035204324951-compute@developer.gserviceaccount.com` 補上 `roles/storage.objectViewer`（Cloud Build 上傳原始碼需要，新啟用 API 後預設服務帳號權限不足的常見坑） |
| Firestore 設定 | `medsafe-554b7`（**注意：跟 Cloud Run 的 project 不同**）的 `admin_data/main.systemSettings.fhirUrl` 已改為上面的 Service URL |
| 健康檢查 | `curl https://medsafe-fhir-1035204324951.asia-east1.run.app/fhir/metadata` → HTTP 200，HAPI FHIR 8.12.0 |
| 測試 | `npm test` 185/185 全數通過（不受這次變更影響，FHIR 呼叫都有 try/catch 與逾時保護） |

---

## 🔴 2026-09-03 發現：自架伺服器沒有存取控制，而警告因此被自動關掉

這一節是本文件建立時**完全沒有想到**的問題，且比持久化嚴重。

### 實測

```
GET https://medsafe-fhir-1035204324951.asia-east1.run.app/fhir/Patient?_count=1
（未帶任何憑證）  →  HTTP 200
```

`js/fhir-client.js` 從頭到尾沒有送出 `Authorization` 標頭，而系統的三個 POST 都成功——
代表這台伺服器**讀寫皆對全世界開放**。稽核報告 9.1 自己訂的驗收標準
「未帶 `Authorization` 標頭的請求一律回 401」**未達成**。

### 真正的問題：警告燈綁錯了對象

介面上所有「資料會外流」的警告，原本掛在這個判斷上：

```javascript
// js/fhir-client.js（修復前）
isPublicSandbox() { return /(^|\/\/)hapi\.fhir\.org/i.test(_base); },
```

它判斷的是**網址是不是 hapi.fhir.org**，不是**這台伺服器有沒有存取控制**。
Firestore 的 `fhirUrl` 一改成 Cloud Run 網址，這個判斷就回 false，
於是 `dashboard.html`、`patient.html`（兩處）、`insurance.html` 的
`v-if="fhirIsPublic"` 警告**全部消失**。

淨效果：**搬家前是「伺服器全開 + 有警告」，搬家後變成「伺服器一樣全開 + 沒有警告」。**
這是嚴格的退步——使用者失去了唯一的提示。

錯誤的形狀與稽核報告 P0-3、P0-4 完全相同：判斷條件綁在一個**代理指標**上
（網址長什麼樣），而不是綁在它真正要描述的那件事上（有沒有存取控制）。
網址一改變，代理指標與事實就脫鉤了。

### 修復（2026-09-03，已完成）

| 變更 | 內容 |
|---|---|
| `js/fhir-client.js` | 新增 `isUnprotected()` 取代 `isPublicSandbox()` 作為警告依據。判斷依據：hapi.fhir.org 恆為未受保護；其餘位址看管理端是否**明確具結**已設定存取控制，**預設為否** |
| `js/fhir-client.js` | 新增 `host()`，介面改為顯示實際主機名，取代寫死的 `hapi.fhir.org`（寫死的文字換伺服器後會變成不實陳述） |
| `admin.html` | 新增「我具結此伺服器已設定存取控制」勾選框，明白標示**勾選不會產生任何保護**，且變更會寫入稽核記錄 |
| 四端警告文字 | 改為「該伺服器目前沒有存取控制，任何人皆可讀取」+ 實際主機名，對公開沙箱與自架開放伺服器都成立 |
| `tests/fhir-client.test.mjs` | 新增 14 項測試並接入 `npm test`，釘住 default-deny |

**為什麼預設必須是「未受保護」**：系統無法自行驗證對方有沒有存取控制，
而「不知道」不可以呈現為「安全」——那正是本專案從 P0-3 一路反對的事。

**為什麼具結欄位不叫「已加上存取控制」而叫「我具結」**：本連線層不送任何憑證，
系統驗不了這件事。與病患摘要的 `attestedBy` 同一種處理——
系統驗不了的事，就標明是**誰說的**，不要假裝是系統確認的。

### 測試為什麼抓不到原本的缺陷（值得記下來）

`isPublicSandbox()` **就其自身定義而言完全正確**——它真的有正確判斷出
網址是不是 hapi.fhir.org。錯的是它被拿去回答另一個問題。

因此任何「測 isPublicSandbox() 認不認得 hapi.fhir.org」的測試都會通過，
永遠抓不到這個缺陷。新測試改為釘住那個真正重要的性質：
**只要沒有人明確具結，任何網址都必須判定為未受保護**——
包括今天還不存在的新網址。缺陷當初正是由一個新網址觸發的。

### 仍未解決

伺服器本身**依然是開放的**。要真的擋下未授權請求，在純前端架構下需要後端代理
持有憑證（稽核報告 Phase 5 已論證：任何前端金鑰都會送到瀏覽器）。
目前的處置是**據實告知**，不是**實際保護**。減輕情節的是上傳資料仍走化名機制
（不送姓名、出生年模糊化），且 `PUT Patient/P001` 的全球 ID 碰撞問題
確實因為換到自己的伺服器而解決了。

---

## ⚠️ 待處理：資料持久化

### 問題

目前 HAPI FHIR 用**內嵌 H2 資料庫**，資料存在容器記憶體。Cloud Run 容器**閒置一段時間會被回收**，下次請求會啟動全新容器，H2 從零開始 —— **資料會消失**。

### 會不會影響到系統核心功能？不會，但要知道邊界在哪

系統其實有**兩套獨立資料庫**：

| | Firestore（`medsafe-554b7`） | FHIR Server（Cloud Run） |
|---|---|---|
| 存什麼 | 使用者帳號、病患資料、處方紀錄、稽核記錄、系統設定 | Patient／MedicationStatement／MedicationRequest／Flag 等 FHIR 資源 |
| 是系統的唯一真實來源嗎 | ✅ 是，所有畫面都從這裡讀 | ❌ 不是，只是「同步」出去的一份 FHIR 格式副本 |
| 持久化 | ✅ 一直都是，跟這次部署無關 | ⚠️ 目前不是，見下 |

**處方、病歷、稽核軌跡完全不受影響。** 會消失的只是同步到 FHIR Server 那份副本。

### 具體會消失的三種資料（呼叫點）

| 檔案:行號 | 寫入資源 | 觸發時機 |
|---|---|---|
| `patient.html:1231` | Bundle（Patient + MedicationStatement） | 病患按「同步至 FHIR」 |
| `patient.html:1280` | Flag（交互作用知情同意記錄） | 病患確認警示後 |
| `dashboard.html:1359` | MedicationRequest（醫師開立處方同步） | 醫師開藥同步 |

`insurance.html:1073` 只有讀（查核用），若查的 Patient 已被清空的容器接手，會顯示「查無資料」——但只要病患重新按一次同步，資料會從 Firestore 重新產生，並不是真的遺失。

### 什麼時候會清空

Cloud Run 容器閒置沒有請求就會被回收。實務上：
- Demo 中間休息一下回來 → 可能已清空
- 隔一天再開 → 幾乎確定已清空

**2026-09-03 實測確認，預測完全命中**：

```
GET /fhir/Patient?_count=5            →  "total": 0
GET /fhir/MedicationStatement?_summary=count  →  "total": 0
```

本文件建立於 09-02，隔天查即為空。**Demo 前務必先跑一次同步流程**，
否則畫面上的跨院查核會顯示查無資料。

---

## 🎯 三個方案（**2026-09-03 決議：採方案 C**）

> **決議理由**：以競賽展示用途，花 US$8-12／月讓一份「不是唯一真實來源的副本」
> 持久化，對評分沒有加分。Firestore 那份真正的病歷、處方與稽核軌跡本來就一直是持久的，
> 不受影響。Demo 前重新同步一次即可。
>
> **代價已知且可接受**：跨院查核在資料被清空後會顯示「查無紀錄」，
> 而 `insurance.html` 已有 `fhirCheckStatus === 'not-synced'` 的文案
> 明白說明「這不是查詢失敗，也不代表其用藥有異常」——這個情境本來就已經處理過了。
>
> 之後若要給評審或使用者長期測試，再回來看方案 A。

### 方案 A：Cloud SQL（PostgreSQL）—— 有費用
- `db-f1-micro`：約 US$7-10／月 + 儲存空間 US$1-2／月，**合計約 US$8-12／月（約台幣 250-370）**
- **不是永久免費**（跟 Cloud Run 不同），若這個帳號有 $300 美金新戶試用金，90 天內會被蓋掉，之後開始真的扣款
- 全託管、自動備份、穩定可靠，適合長期使用
- 部署方式：`gcloud sql instances create` + Cloud Run `--add-cloudsql-instances` 連線
- ⚠️ 技術細節待確認：HAPI FHIR 官方 Docker image 是否已內建 Cloud SQL Socket Factory（`com.google.cloud.sql:postgres-socket-factory`），沒有的話走 Unix Socket 連線會失敗，需要改用公開 IP + TCP/SSL 連線，或自訂 Dockerfile 加這個依賴

### 方案 B：Compute Engine e2-micro（永久免費層）+ 自架 PostgreSQL
- **真正 0 元**（Google Cloud Always Free 額度）
- 但要自己顧：裝 PostgreSQL、設定備份、處理安全性更新、開防火牆規則
- 維護成本轉嫁給自己，適合有餘力長期維運的情況

### 方案 C：先不處理，接受資料會重來
- 目前的 H2 方案完全免費，不用多做任何事
- 適合**單純展示 demo 用**：demo 前重新同步一次即可
- 等真的要正式上線、多人長期使用前再處理

---

## 📝 決議後的待辦

**已決議採方案 C（先擱置持久化）**，因此目前只剩兩件事：

- [ ] **Demo 前先跑一次同步流程**確認 FHIR 端資料是新的（容器閒置就會清空，已於 09-03 實測確認）
- [ ] 若日後要給評審或使用者長期測試，再回頭評估方案 A；屆時先確認：
      ```bash
      # 檢查 HAPI FHIR image 裡有沒有內建 Cloud SQL Socket Factory
      # （沒有的話要嘛改用公開 IP + SSL 連線，要嘛自訂 Dockerfile 加依賴）
      ```

**存取控制**（第二節）的警告呈現已修正並有測試涵蓋；
伺服器本身要真的擋下未授權請求，需後端代理，列於稽核報告 Phase 6。

---

## 相關檔案

- `js/fhir-client.js` — FHIR 連線層，`DEFAULT_BASE` 是 fallback，實際位址讀 Firestore `admin_data/main.systemSettings.fhirUrl`；存取控制具結讀同一份文件的 `fhirAccessControlled`（預設 false）
- `tests/fhir-client.test.mjs` — 連線層測試（14 項），已接入 `npm test`，釘住「未具結一律視為未受保護」
- `Dockerfile`（本次新增，位於 repo 根目錄）— 目前只有 `FROM hapiproject/hapi:latest`，方案 A 若需要額外依賴會在這裡加
- 稽核報告 Phase 5：`D:\競賽\FHIR大健康競賽\江\江\決賽檔案\04_Security_Audit\MedSafe_系統稽核報告.md`（第九章 9.1 記錄了「自架 FHIR Server」的決議，這份 TODO 是該決議的執行進度）
