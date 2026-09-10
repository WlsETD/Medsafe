// 自由文字服藥回報的語意理解測試（優先 1）。
//
// 這份測試守的是三件不可退讓的事：
//   一、LLM 只負責抽詞。它輸出的任何藥名都不會直接變成病歷欄位——
//       ATC 一律來自病患既有的 medications，因此 LLM 幻覺不可能污染病歷。
//   二、對不到唯一結果時不猜，改追問。
//   三、使用者說「沒吃」時不寫入。
//
// LLM 呼叫全程 mock，不打真的 API。
//
// 執行：node tests/line-nlu.test.mjs（不需要 Firestore 模擬器）

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const llm = require('../functions/src/llm.js');
const nlu = require('../functions/src/nlu.js');
const medMatch = require('../functions/src/med-match.js');

const results = [];
const check = (name, cond, detail) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (detail || '')]);

// 一位典型病患：三種藥、三個提醒時段，其中 08:00 那格含兩種藥。
const PATIENT = {
  medications: [
    { atc: 'C09AA03', name: 'Lisinopril', zhName: '賴諾普利', category: '降血壓藥', hospital: '台大醫院' },
    { atc: 'A10BA02', name: 'Metformin', zhName: '二甲雙胍', category: '降血糖藥', hospital: '榮總醫院' },
    { atc: 'C10AA05', name: 'Atorvastatin', zhName: '阿托伐他汀', category: '降血脂藥', hospital: '馬偕醫院' }
  ],
  reminders: [
    { time: '08:00', text: '服用賴諾普利、阿托伐他汀' },
    { time: '12:00', text: '服用二甲雙胍 (飯後)' },
    { time: '22:00', text: '服用阿托伐他汀' }
  ]
};

// 讓 mock 回傳指定的抽詞結果。參數形狀與 OpenAI 的 chat/completions 回應相同，
// 因為 llm.js 會走 parseStructuredOutput() 解析——連解析那一段也一起測到。
function mockExtract(items) {
  llm.setImpl(async () => ({
    choices: [{ message: { content: JSON.stringify({ items }) } }]
  }));
}

const run = async () => {

  // ── 一、藥物比對：三層證據 ─────────────────────────────────────────
  // 這一層不經過 LLM，直接測比對函式本身。

  {
    const hits = medMatch.matchOne('賴諾普利', PATIENT.medications);
    check('目錄命中：中文學名解析到唯一用藥',
      hits.length === 1 && hits[0].med.atc === 'C09AA03' && hits[0].confidence === medMatch.CONF_CATALOG);
  }
  {
    // 商品名。長輩手上的藥袋常印商品名而非學名。
    const hits = medMatch.matchOne('立普妥', PATIENT.medications);
    check('目錄命中：商品名（立普妥）解析到 Atorvastatin',
      hits.length === 1 && hits[0].med.atc === 'C10AA05');
  }
  {
    // 這是整支功能的代表性句子：長輩說的是類別，不是藥名。
    const hits = medMatch.matchOne('血壓藥', PATIENT.medications);
    check('類別命中：「血壓藥」對上 category「降血壓藥」',
      hits.length === 1 && hits[0].med.atc === 'C09AA03' && hits[0].confidence === medMatch.CONF_CATEGORY);
  }
  {
    const hits = medMatch.matchOne('阿托伐', PATIENT.medications);
    check('子字串命中：簡稱「阿托伐」對上阿托伐他汀',
      hits.length === 1 && hits[0].confidence === medMatch.CONF_SUBSTRING);
  }
  {
    // 【回歸測試】dashboard.html 醫師開立處方寫入的病歷形狀：name_en/name_zh，
    // 完全沒有 category 欄位（這正是示範資料與真實處方唯一不同、也是曾經
    // 讓「血壓藥」對真實病患完全比對不到的地方）。類別命中必須改用 ATC
    // 反查目錄的 class_zh，不能只看 m.category。
    const realRxShapeMed = [
      { atc: 'C09AA03', name_en: 'Lisinopril', name_zh: '賴諾普利', hospital: '本院 (醫師開立)' }
    ];
    const hits = medMatch.matchOne('血壓藥', realRxShapeMed);
    check('類別命中對真實處方形狀（name_en/name_zh，無 category）同樣生效',
      hits.length === 1 && hits[0].confidence === medMatch.CONF_CATEGORY);
  }
  {
    // 【最重要的一條】不在病患用藥清單裡的藥，即使藥物目錄認得它，也不可命中。
    // 華法林是目錄裡真實存在的藥，但這位病患沒在吃。
    const hits = medMatch.matchOne('華法林', PATIENT.medications);
    check('候選集限縮：目錄認得但病患沒在吃的藥不得命中', hits.length === 0);
  }
  {
    const hits = medMatch.matchOne('感冒藥', PATIENT.medications);
    check('查無：不認得的描述回傳空陣列，不猜最接近的', hits.length === 0);
  }

  // ── 二、LLM 幻覺不得污染病歷 ───────────────────────────────────────
  {
    // 餵一個 LLM 自己編出來的 ATC 碼與偽藥名。
    mockExtract([
      { name: 'NOATC-FAKE', action: 'taken', time: null, confidence: 0.99 },
      { name: '神奇降壓靈', action: 'taken', time: null, confidence: 0.99 }
    ]);
    const r = await nlu.processUserInput('吃了神奇降壓靈', PATIENT);
    check('LLM 幻覺的藥名與 ATC 碼一律落到 unmatched，不寫入',
      r.status === 'ok' && r.toRecord.length === 0 && r.unmatched.length === 2,
      JSON.stringify(r));
  }
  {
    // 就算 LLM 給了正確藥名，寫入用的 ATC 也必須來自病歷那一筆，不是 LLM 給的。
    mockExtract([{ name: '血壓藥', action: 'taken', time: null, confidence: 0.95 }]);
    const r = await nlu.processUserInput('血壓藥吃了', PATIENT);
    const med = r.toRecord[0] && r.toRecord[0].med;
    check('寫入用的藥物身分取自病歷，不取自 LLM 輸出',
      !!med && med.atc === 'C09AA03' && med === PATIENT.medications[0],
      JSON.stringify(r.toRecord));
  }

  // ── 三、正常路徑 ───────────────────────────────────────────────────
  {
    mockExtract([{ name: '血壓藥', action: 'taken', time: null, confidence: 0.95 }]);
    const r = await nlu.processUserInput('剛吃完血壓藥', PATIENT);
    check('自由文字「剛吃完血壓藥」對應到 08:00 時段',
      r.status === 'ok' && r.toRecord.length === 1 && r.toRecord[0].slot.time === '08:00',
      JSON.stringify(r));
  }
  {
    // 文件裡的代表句：一句話講兩種藥，且兩種狀態不同。
    mockExtract([
      { name: '血壓藥', action: 'taken', time: null, confidence: 0.95 },
      { name: '降血糖', action: 'skipped', time: null, confidence: 0.9 }
    ]);
    const r = await nlu.processUserInput('剛吃完血壓藥，但忘記吃降血糖那顆', PATIENT);
    check('一句兩種藥：吃了的寫入、忘記的不寫入',
      r.status === 'ok'
      && r.toRecord.length === 1 && r.toRecord[0].med.atc === 'C09AA03'
      && r.notRecorded.length === 1 && r.notRecorded[0].med.atc === 'A10BA02',
      JSON.stringify(r));
  }

  // ── 四、「沒吃」絕不寫入 ───────────────────────────────────────────
  {
    mockExtract([{ name: '血壓藥', action: 'skipped', time: null, confidence: 0.99 }]);
    const r = await nlu.processUserInput('血壓藥還沒吃', PATIENT);
    check('明確說「沒吃」時 toRecord 為空（病歷不可刪除，寧可不寫）',
      r.status === 'ok' && r.toRecord.length === 0 && r.notRecorded.length === 1);
  }
  {
    mockExtract([{ name: '血壓藥', action: 'uncertain', time: null, confidence: 0.99 }]);
    const r = await nlu.processUserInput('血壓藥好像吃了吧', PATIENT);
    check('說「不確定」時同樣不寫入', r.status === 'ok' && r.toRecord.length === 0);
  }

  // ── 五、低信心度改追問，不猜著寫入 ─────────────────────────────────
  {
    // 子字串命中（0.7）低於 MIN_CONFIDENCE_AUTO（0.8）。
    // 這裡刻意用只出現在單一時段的賴諾普利：若挑一個橫跨兩個時段的藥，
    // 會先落到 pick-slot 分支而測不到信心度這條線。
    mockExtract([{ name: '賴諾', action: 'taken', time: null, confidence: 0.95 }]);
    const r = await nlu.processUserInput('賴諾吃了', PATIENT);
    check('比對信心度不足時改追問，不直接寫入',
      r.status === 'ok' && r.toRecord.length === 0
      && r.confirm.some(c => c.kind === 'low-confidence'),
      JSON.stringify(r));
  }
  {
    // LLM 自己就沒把握。比對再準也不該寫入——取兩者較低者。
    mockExtract([{ name: '血壓藥', action: 'taken', time: null, confidence: 0.4 }]);
    const r = await nlu.processUserInput('好像是血壓的那個？', PATIENT);
    check('LLM 自身信心度低時不寫入，即使比對層命中',
      r.status === 'ok' && r.toRecord.length === 0 && r.confirm.length > 0);
  }
  {
    check('有效信心度取 LLM 與比對層的較低者',
      nlu.effectiveConfidence(0.4, 0.95) === 0.4 && nlu.effectiveConfidence(0.99, 0.7) === 0.7);
  }

  // ── 六、一顆藥橫跨多個時段：讓使用者指定，不替他選 ─────────────────
  {
    // 阿托伐他汀同時出現在 08:00 與 22:00
    mockExtract([{ name: '阿托伐他汀', action: 'taken', time: null, confidence: 0.95 }]);
    const r = await nlu.processUserInput('阿托伐他汀吃了', PATIENT);
    check('同一種藥橫跨兩個時段時改追問，不擅自挑一個',
      r.status === 'ok' && r.toRecord.length === 0
      && r.confirm.some(c => c.kind === 'pick-slot' && c.slots.length === 2),
      JSON.stringify(r));
  }

  // ── 七、LLM 故障一律退回 fallback ──────────────────────────────────
  {
    llm.setImpl(async () => { throw new Error('429 rate limit'); });
    const r = await nlu.processUserInput('血壓藥吃了', PATIENT);
    check('LLM 呼叫失敗時回 error 狀態（由 webhook 退回按鈕流程）',
      r.status === 'error' && /429/.test(r.error));
  }
  {
    llm.setImpl(async () => ({ choices: [{ message: { content: '這不是 JSON' } }] }));
    const r = await nlu.processUserInput('血壓藥吃了', PATIENT);
    check('LLM 回傳非 JSON 時視為錯誤，不得當成「查無藥物」', r.status === 'error');
  }
  {
    mockExtract([]);
    const r = await nlu.processUserInput('今天天氣真好', PATIENT);
    check('句子裡沒提到藥時回 no-extraction，不編造回報', r.status === 'no-extraction');
  }

  // ── 八、沒有提醒時段的藥無處可寫 ───────────────────────────────────
  {
    const patient = {
      medications: [{ atc: 'C09AA03', name: 'Lisinopril', zhName: '賴諾普利', category: '降血壓藥' }],
      reminders: []
    };
    mockExtract([{ name: '血壓藥', action: 'taken', time: null, confidence: 0.95 }]);
    const r = await nlu.processUserInput('血壓藥吃了', patient);
    check('藥在病歷裡但沒有提醒時段時不寫入，據實回報',
      r.status === 'ok' && r.toRecord.length === 0
      && r.notRecorded.some(n => n.reason === 'no-slot'),
      JSON.stringify(r));
  }

  llm.resetImpl();

  // --- 輸出 ---
  console.log('');
  for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '\n      ' + r[2] : '');
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
};

run();
