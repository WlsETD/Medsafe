# Rich Menu Icons

**更新日期**：2026-09-10
**狀態**：✅ 正式版

## 說明

六個圖示由 AI 生圖工具（Gemini）依 `PROMPT.md`（專案根目錄）的 prompt 產生，
原始檔為白底 JPG，經去背（flood fill 去除背景白色、保留圖形內部的白色區域，
例如書本的白色內頁）處理成透明背景 PNG 後放在這裡。

## 對應表

| 檔名 | 功能 | 圖示內容 |
|---|---|---|
| `med-box.png` | 藥箱／查看用藥 | 橘紅雙色膠囊 |
| `appointment.png` | 線上預約 | 紫藍桌曆，標示日期 14 |
| `symptom.png` | 回報不適 | 紫藍聽診器線稿 |
| `guide.png` | 使用說明 | 藍色翻開書本 |
| `drug-check.png` | 用藥查詢 | 青紫放大鏡檢視膠囊 |
| `schedule.png` | 服藥時間表 | 紫色印表機列印清單 |

## 之後要換圖怎麼做

1. 用 `PROMPT.md` 的 prompt（或修改後的版本）重新生圖，存成白底 JPG／PNG。
2. 如果背景不是全透明，先去背（去除背景白色，保留圖形內部的白色區域，
   flood fill 從四個邊界往內找連通的白色像素即可，不要對整張圖做全域去白，
   否則會把圖形內部的白色細節一起挖空——例如 `guide.png` 書頁的白色）。
3. 另存成同樣的檔名覆蓋這裡，接著重新產生 `functions/assets/richmenu.png`
   （用 `functions/assets/richmenu-source.html` 排版、截圖、裁切成
   2500×1686，見該檔案開頭註解），再到 admin.html 點「更新 LINE 選單圖片」
   讓新圖片正式生效。
