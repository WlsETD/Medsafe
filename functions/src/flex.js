// LINE Flex Message 版型。
//
// 【設計取向：這是給長輩看的】
// 字級一律 lg 以上、按鈕高度不用 sm、一張卡片不超過三個動作。
// 顏色只用兩種語意（提醒＝主色、警示＝紅），不做漸層與圖示裝飾——
// 在老花與強光下，對比度比美觀重要。

const MAX_LABEL = 20;  // LINE 對 button label 的長度上限

function clip(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

// 每日用藥彙整卡。
//
// 【為什麼是一天一張卡，而不是每個時段各推一則】
// 一、成本：三個時段各推一則 = 90 則/人/月，輕用量方案（每月 200 則免費）
//     只夠服務兩個人。一天一張 = 30 則/人/月。
// 二、干擾：長輩對「一天被打斷三次」的容忍度遠低於一次。
// 三、功能沒有減少：回報按鈕仍然是三個，按下去走 reply（免費）。
function dailyReminderCard(displayName, dayKey, reminders) {
  const rows = reminders.map(r => ({
    type: 'button',
    style: 'primary',
    height: 'md',
    margin: 'md',
    action: {
      type: 'postback',
      label: clip('✓ ' + r.time + ' 已服用', MAX_LABEL),
      // postback data 上限 300 bytes，因此只帶 time，
      // 藥名由伺服器端從 reminders 反查（見 adherence.js 的說明）。
      data: 'action=taken&day=' + dayKey + '&time=' + encodeURIComponent(r.time),
      displayText: r.time + ' 已服用'
    }
  }));

  const list = reminders.map(r => ({
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    margin: 'md',
    contents: [
      { type: 'text', text: r.time, size: 'lg', weight: 'bold', color: '#1F7A8C', flex: 2 },
      { type: 'text', text: clip(r.text, 40), size: 'lg', wrap: true, flex: 5 }
    ]
  }));

  return {
    type: 'flex',
    altText: '今天的用藥提醒（' + reminders.length + ' 個時段）',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '今天的用藥', size: 'xl', weight: 'bold', color: '#1F7A8C' },
          { type: 'text', text: displayName + '　' + dayKey, size: 'sm', color: '#888888', margin: 'sm' },
          { type: 'separator', margin: 'lg' },
          ...list,
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '吃完請按下對應的時段', size: 'sm', color: '#888888', margin: 'lg' },
          ...rows
        ]
      }
    }
  };
}

// 跨院交互作用警示。
//
// 這是整個系統唯一「別家做不到」的一則訊息：單一醫院的官方帳號結構上
// 不可能知道病患在別家醫院拿了什麼藥。因此措辭上刻意點名兩家醫院——
// 那正是這則警示的資訊來源，也是它的說服力所在。
// findings 必須是 ddi.decorate() 處理過的（帶 display.a / display.b）——
// 引擎原始的 f.a / f.b 沒有中文藥名與醫院欄位，理由見 ddi.js 的 describe()。
function ddiAlertCard(newMedName, findings) {
  const items = findings.slice(0, 3).map(f => {
    const a = (f.display && f.display.a) || {}, b = (f.display && f.display.b) || {};
    const nameA = a.name || '（未知）';
    const nameB = b.name || '（未知）';
    const from = [a.hospital, b.hospital].filter(Boolean);
    const where = from.length === 2 && from[0] !== from[1] ? from[0] + ' × ' + from[1] : from[0] || '';
    return {
      type: 'box',
      layout: 'vertical',
      margin: 'lg',
      contents: [
        {
          type: 'text',
          text: nameA + '　＋　' + nameB,
          size: 'lg', weight: 'bold', wrap: true, color: '#B3261E'
        },
        {
          type: 'text',
          text: (f.severityZh || f.severity || '') + (where ? '　·　' + where : ''),
          size: 'sm', color: '#888888', margin: 'xs', wrap: true
        }
      ]
    };
  });

  return {
    type: 'flex',
    altText: '用藥安全提醒：' + newMedName + ' 有 ' + findings.length + ' 項交互作用',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '⚠️ 用藥安全提醒', size: 'xl', weight: 'bold', color: '#B3261E' },
          {
            type: 'text',
            text: '您新增的「' + clip(newMedName, 20) + '」與目前的用藥有交互作用',
            size: 'md', wrap: true, margin: 'md'
          },
          { type: 'separator', margin: 'lg' },
          ...items,
          { type: 'separator', margin: 'lg' },
          {
            type: 'text',
            // 這句話的分寸很重要：系統不能叫病患停藥（那是處方權），
            // 也不能輕描淡寫。只能請他去問開藥的人。
            text: '請勿自行停藥。下次回診時，或以電話向您的醫師或藥師確認這個組合。',
            size: 'sm', color: '#555555', wrap: true, margin: 'lg'
          }
        ]
      }
    }
  };
}

module.exports = { dailyReminderCard, ddiAlertCard };
