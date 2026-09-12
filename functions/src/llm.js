// OpenAI API 薄封裝。支持注入 mock 供測試使用。

const { OPENAI_API_KEY } = require('./config');
const ddi = require('./ddi');

// 全局 LLM 呼叫函式，可被 mock 覆蓋
let llmImpl = null;

// 標準的 OpenAI 調用實作
async function openaiCall(params) {
  const apiKey = OPENAI_API_KEY.value();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(params)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const msg = `OpenAI API error ${res.status}: ${text.slice(0, 200)}`;
    throw new Error(msg);
  }

  return res.json();
}

// 解析 structured output 回傳的內容。OpenAI 在 response_format 設為
// json_schema 時，把 JSON 字串放在 message.content 的第一個 text block 裡。
function parseStructuredOutput(response) {
  const choice = response.choices && response.choices[0];
  if (!choice || !choice.message) throw new Error('無效的 OpenAI 回應結構');
  const content = choice.message.content;
  if (typeof content !== 'string') throw new Error('OpenAI 回應不含文字');
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error(`JSON 解析失敗: ${content.slice(0, 100)}`);
  }
}

// 意圖清單。
//
// 【為什麼意圖與抽詞放在同一次呼叫】
// 先分類、再抽詞會是兩次 API 往返：成本翻倍，延遲也翻倍，而 LINE 的
// replyToken 有時效。structured output 本來就能一次回多個欄位，
// 讓模型在讀同一句話時同時給出兩者，成本與現在完全一樣。
//
// 【為什麼要有這一層】
// 在這之前，模型唯一被交付的任務是「抽出提到了哪些藥」。使用者問
//「藥箱裡有什麼」「下次回診是哪天」，模型抽不到藥名就回空陣列，
// webhook 因此回一句制式的「我不太確定您的意思」——看起來像聽不懂，
// 實際上是根本沒有被問到那個問題。
const INTENTS = [
  'adherence-report',  // 回報服藥：「早上的藥吃了」
  'cabinet-query',     // 想知道自己目前在吃什麼藥
  'booking',           // 想預約／掛號／改約
  'next-visit',        // 問下次回診是什麼時候
  'help',              // 問這個服務會做什麼
  'discomfort',        // 表達身體不適
  'other'              // 以上皆非（含用藥知識問題、閒聊）
];

// 【公用 API】理解一句自由文字：同時回傳意圖與（若為服藥回報）抽出的藥物。
// 【參數】
//   text: 使用者輸入（例如「剛吃完血壓藥，但忘記吃降血糖那顆」）
//   patientMeds: 病患的現有用藥陣列（供上下文參考）
// 【回傳】
//   { intent: 'adherence-report', items: [{ name, action, time, confidence }, ...] }
async function understandMessage(text, patientMeds) {
  const impl = llmImpl || openaiCall;
  // 名稱與類別都要兼顧兩種病歷形狀（見 med-match.js 對應的長註解）：
  // mockData.js 示範資料用 zhName/name/category；dashboard.html 醫師開立
  // 處方寫入的是 name_en/name_zh，且從不帶 category，要用 ATC 反查目錄的
  // class_zh。少了這層，LLM 看到的病患用藥清單對真實病患會是一串空白。
  const medContext = (patientMeds || [])
    .map(m => {
      const name = ddi.catalog().medDisplayName(m).zh;
      const catalogEntry = m.atc ? ddi.catalog().byAtc(m.atc) : null;
      const category = (catalogEntry && catalogEntry.class_zh) || m.category || '';
      return `- ${name} (${category}，${m.hospital || ''})`;
    })
    .join('\n');

  const response = await impl({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `你是一個用藥管理助手的理解層。判斷使用者這句話想做什麼，
若是回報服藥，另外抽出提到的藥物。

病患的現有用藥清單：
${medContext || '（無）'}

【任務一：判斷意圖 intent】從下列擇一：
- adherence-report：回報有沒有吃藥。例：「早上的藥吃了」「血壓藥忘記吃」
- cabinet-query：想知道自己目前在吃哪些藥。例：「我有哪些藥」「幫我看看藥箱裡有什麼」「我在吃什麼」
- booking：想預約、掛號、改約、取消預約。例：「我要看診」「下週三可以約嗎」
- next-visit：問下一次回診／預約是什麼時候。例：「我下次什麼時候回診」「我約了幾號」
- help：問這個服務能做什麼。例：「你會什麼」「怎麼用」
- discomfort：表達身體不舒服或疑似藥物副作用。例：「我頭很暈」「吃完想吐」
- other：以上皆非。**包含所有用藥知識與醫療問題**（例：「這個藥能配葡萄柚嗎」
  「可以自己停藥嗎」「這兩個藥一起吃會怎樣」）以及閒聊。

【任務二：抽詞 items】僅在 intent 為 adherence-report 時才填，其餘一律回空陣列。
1. 找出文字裡提到的藥物名稱（可能是中文名、類別、或簡稱）
2. 判定動作：服用（taken）/ 未服用（skipped）/ 不確定（uncertain）
3. 若提到時間（例如「早上吃」），正規化為 HH:MM 格式，否則 null
4. 信心度 0–1，只有確定時才 > 0.8

【限制】
- 絕不生成虛構的藥名或 ATC 碼
- 查無藥物時回傳空陣列，不猜測
- 同一種藥只報一次（e.g., 「血壓藥和降血脂藥」= 兩筆）
- 不要回答任何醫療問題，那不是你的工作——判成 other 即可`
      },
      { role: 'user', content: text }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'MessageUnderstanding',
        schema: {
          type: 'object',
          properties: {
            intent: {
              type: 'string',
              enum: INTENTS,
              description: '使用者這句話想做什麼'
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: '藥物名稱或類別' },
                  action: {
                    type: 'string',
                    enum: ['taken', 'skipped', 'uncertain'],
                    description: '服用狀態'
                  },
                  time: {
                    type: ['string', 'null'],
                    description: 'HH:MM 格式或 null'
                  },
                  confidence: {
                    type: 'number',
                    minimum: 0,
                    maximum: 1,
                    description: '信心度'
                  }
                },
                required: ['name', 'action', 'time', 'confidence']
              }
            }
          },
          required: ['intent', 'items']
        }
      }
    }
  });

  const parsed = parseStructuredOutput(response);
  return {
    // intent 缺席時一律當成服藥回報，維持加入意圖分類之前的行為。
    // 這條後備不只是為了測試替身：模型若因故沒吐出 intent，
    // 退回舊行為（抽詞 → 抽不到就回 fallback）遠比把一句正常的
    // 服藥回報誤判成 other、直接拒答要好。
    intent: INTENTS.indexOf(parsed.intent) !== -1 ? parsed.intent : 'adherence-report',
    items: parsed.items || []
  };
}

// 【相容包裝】只要抽詞結果的呼叫端沿用這支。
async function extractMedications(text, patientMeds) {
  return (await understandMessage(text, patientMeds)).items;
}

module.exports = {
  INTENTS,
  understandMessage,
  extractMedications,
  // 【測試用】注入 mock 實作
  setImpl(fn) { llmImpl = fn; },
  // 【測試用】恢復真實實作
  resetImpl() { llmImpl = null; },
  // 【內部】
  openaiCall,
  parseStructuredOutput
};
