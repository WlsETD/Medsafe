# 家屬邀請「一鍵分享」— liff.shareTargetPicker() 實作 Prompt

這份文件是給未來一次 Claude Code session 直接執行的自包含任務說明（跟 `PROMPT.md` 是同一種
「先寫成 prompt 放著，之後再實作」的用法，只是這份是功能開發，不是圖片生成）。目前**不要
主動做**，等使用者明確要求時才依這份文件動工。

## 背景（為什麼要做這個）

MedSafe 已經有完整的「家屬共照」後端（commit `bcce4a8`）：病患在 `patient.html` 的「家屬檢視」
分頁（`activeView === 'family'`）可以呼叫 `lineCreateFamilyInviteCode` 產生一組 8 碼邀請碼，
畫面上（`patient.html:844-867`）用 QR code + 兩個連結呈現：

- `familyAddFriendUrl`（`patient.html:863-864`）：加 MedSafe 官方帳號好友
- `familySendUrl`（`patient.html:865-866`，標籤「用 LINE 傳送這組碼」）：開啟 LINE 並帶出
  一則預填好代碼、要送給官方帳號的訊息

核銷流程（`functions/src/webhook.js:214-244`）：家屬把這組碼**當作一則純文字訊息**傳給
MedSafe 官方帳號，webhook 依序嘗試 `bindings.redeemLinkCode()`（病患本人綁定碼）→
`bindings.redeemFamilyInviteCode()`（家屬邀請碼），核銷成功後回覆 `replyFamilyBound()`。

**現有設計的落差**：上面兩個連結是給「執行動作的那支手機」用的——不管是掃 QR 或點連結，
都只有**家屬自己的手機**在正確的情境下點才有意義（在病患自己手機上點「用 LINE 傳送這組碼」，
開的是病患自己的 LINE，送到官方帳號等於病患自己傳碼給自己，沒有意義）。今天要把邀請碼交給
家屬，病患只能：口頭唸出來、截圖傳出去、或直接把手機遞給家屬讓對方掃 QR。這不算「分享」，
是「轉交」。

## 要做的事

在 `patient.html` 的家屬邀請面板加一個「分享給家人」按鈕，使用 LIFF 的
[`shareTargetPicker`](https://developers.line.biz/en/docs/liff/using-line-features/#share-target-picker) API：
病患（在 `?liff=1` 模式下打開本頁時）點一下，直接從 LINE 內建的好友/群組選擇畫面挑一個
聯絡人，把邀請訊息直接送進對方的聊天室——不需要對方掃 QR、不需要病患把手機遞出去。

### 前置條件（動工前先確認，不是程式問題）

`shareTargetPicker` 需要在 **LINE Developers Console → 該 LIFF App → 開啟「Share target
picker」權限**才能用（預設關閉）。這是後台設定，不是程式碼能控制的，動工前請使用者確認
`LIFF_ID`（病患端 LIFF App，`js/line-liff-config.js` 的 `window.LIFF_ID`）已開啟這個權限；
若還沒開，先引導使用者去開，比照 `LINE_DEVELOPMENT_PLAN.md` 裡「你要做的事」那種後台設定
段落的寫法。

### 實作要點

1. **可用性判斷**：不能只看 `liff.isInClient()`——`shareTargetPicker` 有自己的能力旗標，
   必須用 `liff.isApiAvailable('shareTargetPicker')` 判斷（LINE 版本太舊、或前述權限未開時
   會回 `false`）。按鈕用一個新的 data flag（例如 `canShareInvite`）控制顯示，在
   `patient.html` 檔尾 IIFE 裡、`mounted.isLiffMode` 判斷式旁邊一起設定：
   ```js
   mounted.canShareInvite = mounted.isLiffMode
     && typeof liff.isApiAvailable === 'function' && liff.isApiAvailable('shareTargetPicker');
   ```
2. **UI 位置**：`patient.html:862-867` 那個 `flex flex-wrap gap-3` 區塊裡，在「加入好友」
   「用 LINE 傳送這組碼」旁邊加第三個按鈕，`v-if="canShareInvite"`，標籤例如「分享給家人」。
   不要移除原本兩個連結——`shareTargetPicker` 只在 LIFF 內可用且需要對方也用 LINE，保留
   原有路徑當退路（一般瀏覽器打開、或未開權限時）。
3. **訊息內容**：呼叫 `liff.shareTargetPicker([...])`，訊息陣列建議用一則 `text` 型別，
   內容白話說明這是什麼、要對方做什麼，而不是只丟一個代碼：
   ```
   {{ familyRelationshipLabel || '我' }} 邀請你在 MedSafe 查看用藥狀況。
   請加 MedSafe 官方帳號好友，並把這組代碼傳給它完成連結：{{ familyCode }}
   （10 分鐘內有效，逾期請回來我這裡重新產生）
   ```
   代碼有效期是 `FAMILY_INVITE_TTL_MS`＝30 分鐘（`functions/src/config.js`），文案裡的時間
   要跟 `familyCodeCountdown`／`familyCodeSecondsLeft` 的顯示邏輯一致，不要各寫各的數字。
   若 `familyAddFriendUrl` 存在，一併附進文字裡（一則訊息裡放連結沒問題）。
4. **呼叫時機與例外處理**：`shareTargetPicker` 回傳一個 Promise，使用者取消分享時它會
   resolve 成 `undefined`（不是 reject），這不是錯誤，不要顯示失敗訊息；只有真的
   reject（API 不可用、SDK 內部錯誤）才算失敗，比照本頁其餘 catch 區塊的分寸（例如
   `createFamilyInvite()` 的 `catch (e)`，只在真正失敗時才寫 `familyError`）。
5. **不要動後端**：`bindings.js`／`webhook.js`／`firestore.rules` 完全不需要改——核銷路徑
   不變，家屬收到的還是同一組文字代碼，只是「怎麼送到對方手上」多一種管道。因此**不需要**
   跑 `npm run test:rules`；但若改了 `patient.html` 以外的檔案要留意連動。

### 驗證方式（比照專案既有的「不是嘴說」原則）

用兩支真實裝置測試（同 `LINE_DEVELOPMENT_PLAN.md` 的驗證清單風格）：
- [ ] 病患手機：`patient.html?liff=1` → 家屬檢視 → 產生邀請 → 出現「分享給家人」按鈕
- [ ] 點下去 → 跳出 LINE 原生的好友/群組選擇畫面 → 選一位好友
- [ ] 對方（家屬）手機的 LINE 收到訊息，內容含代碼與加好友連結
- [ ] 家屬依訊息指示把代碼傳給官方帳號 → 收到「已連結」回覆（沿用既有核銷流程，不需另外測）
- [ ] 取消分享（不選人直接返回）→ 病患端不應顯示任何錯誤訊息
- [ ] 在一般瀏覽器（非 LINE 內）打開 `patient.html`（無 `?liff=1`）→ 確認「分享給家人」按鈕
      不出現，原本兩個連結行為不變

### 範圍外（不要一起做）

- 不要把「用 LINE 傳送這組碼」「加入好友」兩個既有連結拿掉，三者並存。
- 不要對 `family.html`／掃 QR 流程做任何改動——這次只加病患端的分享手段。
- 不要嘗試用 `shareTargetPicker` 直接送 Flex Message 卡片——先用最簡單的 `text` 型別驗證
  整條路徑能動，卡片視覺是後續才考慮的加分項，不要一次做兩件事互相卡住除錯。
