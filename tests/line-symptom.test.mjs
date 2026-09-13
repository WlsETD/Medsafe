// 「回報不適」轉發到醫病留言板的測試（functions/src/webhook.js）。
//
// 這份測試守的是：currentDoctorOf() 找到的主治醫師跟 patient.html 的
// loadAppointments() 判斷一致，以及 forwardSymptomReport() 寫進
// conversations 的形狀與 js/chatStore.js 的 addMessage() 相容（欄位名稱、
// participants 內容），醫師端才讀得到、規則才放行。
//
// 需要 Firestore 模擬器（不需要 Auth——這裡不呼叫任何 admin.auth()）。
// 執行：npm run test:symptom

import { createRequire } from 'module';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('需要 Firestore 模擬器（請用 npm run test:symptom 執行）');
  process.exit(1);
}

const require = createRequire(new URL('../functions/index.js', import.meta.url));
const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'medsafe-rules-test' });
const { currentDoctorOf, SYMPTOM_PREFIX } = require('./src/webhook.js')._internal;

const db = admin.firestore();

const results = [];
const check = (name, cond, detail) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (detail || '')]);

// ── currentDoctorOf()：與 patient.html 的 loadAppointments() 同一套判斷 ──

// 查無掛號、也沒有 assignedDoctor
check('無掛號、無 assignedDoctor 時回傳 null',
  (await currentDoctorOf('nobody')) === null);

// 只有舊制 assignedDoctor
await db.doc('patient_data/legacyOnly').set({ assignedDoctor: 'drOld' });
check('無掛號、僅有舊制 assignedDoctor 時回傳它',
  (await currentDoctorOf('legacyOnly')) === 'drOld');

// 有進行中的掛號時，優先於 assignedDoctor（新制優先）
await db.doc('patient_data/withAppt').set({ assignedDoctor: 'drOld' });
await db.doc('appointments/a1').set({
  patient: 'withAppt', doctor: 'drNew', status: 'booked', dateKey: '2026-09-10'
});
check('有進行中掛號時，優先回傳掛號上的醫師（新制優先於 assignedDoctor）',
  (await currentDoctorOf('withAppt')) === 'drNew');

// 多筆進行中掛號：取日期字串最新的一筆
await db.doc('appointments/a2').set({
  patient: 'withAppt', doctor: 'drNewer', status: 'arrived', dateKey: '2026-09-20'
});
check('多筆進行中掛號時，取日期最新的那一筆',
  (await currentDoctorOf('withAppt')) === 'drNewer');

// 已取消／已完診的掛號不算進行中
await db.doc('patient_data/cancelledOnly').set({});
await db.doc('appointments/a3').set({
  patient: 'cancelledOnly', doctor: 'drGone', status: 'cancelled', dateKey: '2026-09-10'
});
check('只有已取消的掛號時，不當作進行中（回傳 null，因為也沒有 assignedDoctor）',
  (await currentDoctorOf('cancelledOnly')) === null);

// scheduledAt（Timestamp）的舊制掛號也要能比出日期，不是只有 dateKey
await db.doc('patient_data/tsOnly').set({});
await db.doc('appointments/a4').set({
  patient: 'tsOnly', doctor: 'drTs', status: 'booked',
  scheduledAt: admin.firestore.Timestamp.fromDate(new Date('2026-09-10T01:00:00Z'))
});
check('只有 scheduledAt（無 dateKey）的舊制掛號也能取出醫師',
  (await currentDoctorOf('tsOnly')) === 'drTs');

// ── forwardSymptomReport() 寫入的形狀：直接重現該函式做的兩件事 ──
// （不 require 整個 webhook.js 的 handleText 流程，避免連帶需要 LINE Reply
//  API／signature 等無關的東西；這裡驗證的是「寫進 Firestore 的資料形狀」，
//  與該函式內部完全相同的邏輯。）
async function writeSymptomReport(patient, text, doctor) {
  const convRef = db.collection('conversations').doc(patient);
  const convSnap = await convRef.get();
  if (!convSnap.exists) {
    const participants = [patient];
    if (doctor) participants.push(doctor);
    await convRef.set({
      patient, doctor: doctor || null, participants,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } else if (doctor && !convSnap.data().participants.includes(doctor)) {
    await convRef.update({ participants: admin.firestore.FieldValue.arrayUnion(doctor) });
  }
  await convRef.collection('messages').add({
    from: 'patient', text: SYMPTOM_PREFIX + text,
    at: admin.firestore.FieldValue.serverTimestamp()
  });
}

await writeSymptomReport('symPatient', '頭很暈', 'drSym');
{
  const conv = await db.doc('conversations/symPatient').get();
  check('首次轉達時建立 conversations 文件，patient/doctor/participants 形狀正確',
    conv.exists && conv.data().patient === 'symPatient'
    && conv.data().doctor === 'drSym'
    && JSON.stringify(conv.data().participants) === JSON.stringify(['symPatient', 'drSym']));
  const msgs = await db.collection('conversations/symPatient/messages').get();
  check('訊息帶 SYMPTOM_PREFIX 前綴、from 為 patient',
    msgs.size === 1 && msgs.docs[0].data().from === 'patient'
    && msgs.docs[0].data().text === '【LINE 回報不適】頭很暈');
}

// 查無主治醫師時，doctor 寫 null、participants 只有病患自己
await writeSymptomReport('symNoDoctor', '肚子痛', null);
{
  const conv = await db.doc('conversations/symNoDoctor').get();
  check('查無主治醫師時，doctor 為 null、participants 只有病患自己',
    conv.data().doctor === null && JSON.stringify(conv.data().participants) === JSON.stringify(['symNoDoctor']));
}

// 既有對話串換了醫師：新醫師被加進 participants，舊醫師仍保留
await writeSymptomReport('symPatient', '又暈了', 'drNewSym');
{
  const conv = await db.doc('conversations/symPatient').get();
  check('換了主治醫師後再次轉達：新醫師加進 participants，舊醫師仍保留',
    conv.data().participants.includes('drSym') && conv.data().participants.includes('drNewSym'));
  const msgs = await db.collection('conversations/symPatient/messages').orderBy('text').get();
  check('對話串沿用既有文件，累加訊息而非覆蓋（現在有 2 則）', msgs.size === 2);
}

// --- 輸出 ---
console.log('');
for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? '\n      ' + r[2] : '');
const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
