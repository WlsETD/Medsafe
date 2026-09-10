# LINE Rich Menu 圖示 — AI 生圖 Prompt

用途：`functions/assets/richmenu-icons/` 目前放的是佔位圖（PIL 程式產生，見該資料夾
`README.md`）。這份文件是拿去丟給 AI 圖片生成工具（DALL·E／Midjourney／Gemini 等）
產出正式版圖示用的 prompt。

**產出後怎麼放回專案**：另存成下表對應的檔名，直接覆蓋
`functions/assets/richmenu-icons/` 裡同名的檔案即可，程式碼路徑不用改。建議規格：
正方形（1024×1024）、透明背景 PNG。

---

## 統一風格前綴（六個都要加在各自 prompt 前面，確保六格風格一致）

```
Flat 2D vector icon, minimalist modern flat design style, solid or
two-tone color fill, no gradients that imply depth, no drop shadow,
no 3D bevels or glossy highlights, clean geometric shapes, centered
composition on a fully transparent background, no text, no watermark,
clean minimal medical app icon, vibrant but professional color palette,
square canvas, high detail --no background
```

---

## 六個圖示

| # | 檔名 | 對應功能 | Prompt（接在上面的統一風格後面） |
|---|---|---|---|
| 1 | `med-box.png` | 藥箱／查看用藥 | `a single capsule pill icon, flat orange and red two-tone fill, simple rounded flat vector style` |
| 2 | `appointment.png` | 線上預約 | `a desk calendar icon with a highlighted date square, flat blue and lavender two-tone fill, simple flat vector style` |
| 3 | `symptom.png` | 回報不適 | `a stethoscope icon coiled into a friendly rounded shape, flat purple and light blue two-tone fill, simple flat vector style` |
| 4 | `guide.png` | 使用說明 | `an open book icon with visible page lines, flat light blue cover with white pages, simple flat vector style` |
| 5 | `drug-check.png` | 用藥查詢 | `a magnifying glass icon examining a small pill, flat teal and purple two-tone fill, simple flat vector style` |
| 6 | `schedule.png` | 服藥時間表 | `a small desktop printer icon printing out a sheet of paper, flat purple and white two-tone fill, simple flat vector style` |

---

## 完整組合範例（第 1 個，med-box.png）

```
Flat 2D vector icon, minimalist modern flat design style, solid or
two-tone color fill, no gradients that imply depth, no drop shadow,
no 3D bevels or glossy highlights, clean geometric shapes, centered
composition on a fully transparent background, no text, no watermark,
clean minimal medical app icon, vibrant but professional color palette,
square canvas, high detail --no background,
a single capsule pill icon, flat orange and red two-tone fill, simple
rounded flat vector style
```

其餘五個依此類推，把對應那一列的主體描述接在統一風格前綴後面即可。
