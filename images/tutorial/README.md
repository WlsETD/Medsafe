# 使用說明教學卡圖片

`functions/src/flex.js` 的 `tutorialCarousel()` 會組出 5 張 Flex 圖文卡（LINE
使用者傳「選單」/「說明」/「help」等字觸發），每張卡的 hero 圖片網址是：

```
https://medsafe-554b7.web.app/images/tutorial/<檔名>
```

請把對應的圖片存成下表檔名放進這個資料夾，接著 `git add` + `firebase deploy
--only hosting` 部署即可生效（不需要改程式碼、不需要更新 Cloud Functions）。

## 對應表

| 檔名 | 對應功能 | 卡片說明文字 |
|---|---|---|
| `cabinet.png` | 藥箱 | 隨時查看目前的用藥清單，還有交互作用警示。 |
| `booking.png` | 線上預約 | 選擇日期與診次，線上掛號不用等電話。 |
| `symptom.png` | 回報不適 | 直接告訴我您的狀況，會轉達給您的主治醫師。 |
| `family.png` | 綁定家屬 | 邀請家人一起用 LINE 查看您的用藥與掛號狀況。 |
| `schedule.png` | 服藥時間表 | 查看今天實際要吃的藥，吃完直接按按鈕回報。 |

## 建議規格

- **比例 1:1**（正方形）——`flex.js` 的 hero 設定是 `aspectRatio: '1:1'`，
  非正方形的圖會被裁切（`aspectMode: 'cover'`）。
- 建議邊長 **800～1040px**，檔案大小盡量壓在 **300KB 以內**（LINE 對單則
  訊息總大小有限制，一次 carousel 帶 5 張圖，圖片太大可能拖慢載入）。
- 格式 PNG 或 JPEG 皆可（LINE Flex image 元件本身不挑格式，只要求
  **https 網址**，不接受 data URI 或相對路徑）。
- 風格建議比照 `functions/assets/richmenu-icons/`（見該資料夾
  `README.md`）走同一套視覺語言，例如同一色調延伸成完整示意圖，而不只是
  單一圖示放大——這裡是「教學情境圖」，適合放操作截圖或示意插畫，
  跟選單上的小圖示（icon）用途不同。

## 圖片就緒前會發生什麼事

`tutorialCarousel()` 現在就能正常運作、按鈕功能不受影響；圖片網址讀不到
時，LINE 用戶端會在 hero 位置顯示灰底佔位框，不影響卡片標題、說明文字與
按鈕的顯示與點擊。
