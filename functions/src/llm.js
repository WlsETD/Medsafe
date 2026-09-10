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

// 【公用 API】抽詞：給定使用者自由文字，回傳結構化的藥物名稱清單。
// 【參數】
//   text: 使用者輸入（例如「剛吃完血壓藥，但忘記吃降血糖那顆」）
//   patientMeds: 病患的現有用藥陣列（供上下文參考）
// 【回傳】
//   [{ name: '血壓藥'|'降血糖藥', action: 'taken'|'skipped'|'uncertain', time: null|HH:MM, confidence: 0.9 }, ...]
async function extractMedications(text, patientMeds) {
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
        content: `你是一個藥物識別助手。分析使用者的自由文字敘述，抽出提到的藥物。

病患的現有用藥清單：
${medContext || '（無）'}

【任務】
1. 找出文字裡提到的藥物名稱（可能是中文名、類別、或簡稱）
2. 判定動作：服用（taken）/ 未服用（skipped）/ 不確定（uncertain）
3. 若提到時間（例如「早上吃」），正規化為 HH:MM 格式，否則 null
4. 信心度 0–1，只有確定時才 > 0.8

【限制】
- 絕不生成虛構的藥名或 ATC 碼
- 查無藥物時回傳空陣列，不猜測
- 同一種藥只報一次（e.g., 「血壓藥和降血脂藥」= 兩筆）`
      },
      { role: 'user', content: text }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'MedicationExtraction',
        schema: {
          type: 'object',
          properties: {
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
          required: ['items']
        }
      }
    }
  });

  const parsed = parseStructuredOutput(response);
  return parsed.items || [];
}

module.exports = {
  extractMedications,
  // 【測試用】注入 mock 實作
  setImpl(fn) { llmImpl = fn; },
  // 【測試用】恢復真實實作
  resetImpl() { llmImpl = null; },
  // 【內部】
  openaiCall,
  parseStructuredOutput
};
