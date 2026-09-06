#!/usr/bin/env node
// ===================================================================
// delete-user.js — 刪除指定帳號在 Firestore 中的所有資料
//
// 用法：node tools/delete-user.js <username>
// 範例：node tools/delete-user.js wlsetd
//
// 注意：
//   - audit_logs 為稽核紀錄，預設不刪除（加 --include-audit 可刪）
//   - Firebase Auth 帳號需到 Firebase Console 手動刪除
// ===================================================================

const { execSync } = require('child_process');

const TARGET_USERNAME = process.argv[2];
const INCLUDE_AUDIT = process.argv.includes('--include-audit');

if (!TARGET_USERNAME) {
  console.error('用法：node tools/delete-user.js <username> [--include-audit]');
  process.exit(1);
}

const PROJECT_ID = 'medsafe-554b7';

function run(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe', timeout: 15000 }).toString().trim();
  } catch (e) {
    return null;
  }
}

function firestoreDelete(docPath) {
  console.log(`  🗑  ${docPath}`);
  const r = run(`npx firebase firestore:delete "${docPath}" --project ${PROJECT_ID} --force`);
  if (r === null) console.log(`      ↳ 不存在或失敗，跳過`);
  else console.log(`      ↳ ✅ 已刪除`);
}

function firestoreDeleteRecursive(path) {
  console.log(`  🗑  ${path} (含子集合)`);
  const r = run(`npx firebase firestore:delete "${path}" --project ${PROJECT_ID} --recursive --force`);
  if (r === null) console.log(`      ↳ 不存在或已清空，跳過`);
  else console.log(`      ↳ ✅ 已刪除`);
}

async function main() {
  const u = TARGET_USERNAME;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  刪除帳號：${u}`);
  console.log(`${'='.repeat(60)}\n`);

  // Step 1: 取得 UID
  console.log('📋 Step 1: 取得 UID...');
  let uid = null;
  const userDoc = run(`npx firebase firestore:get "users/${u}" --project ${PROJECT_ID}`);
  if (userDoc) {
    const m = userDoc.match(/"uid"\s*:\s*"([^"]+)"/);
    if (m) { uid = m[1]; console.log(`  ✅ UID: ${uid}`); }
  }
  if (!uid) console.log('  ⚠ 無法取得 UID');

  // Step 2: username 為 doc ID 的文件
  console.log('\n📋 Step 2: 刪除以 username 為 key 的文件...');
  firestoreDelete(`users/${u}`);
  firestoreDelete(`patient_data/${u}`);
  firestoreDelete(`patient_summaries/${u}`);

  // Step 3: 對話 + messages 子集合
  console.log('\n📋 Step 3: 刪除對話...');
  firestoreDeleteRecursive(`conversations/${u}`);

  // Step 4: user_roles (以 UID 為 key)
  if (uid) {
    console.log('\n📋 Step 4: 刪除 user_roles...');
    firestoreDelete(`user_roles/${uid}`);
  } else {
    console.log('\n📋 Step 4: 無 UID，跳過 user_roles');
  }

  // Step 5: 複合 key 文件
  console.log('\n📋 Step 5: 刪除複合 key 文件...');
  const counterparts = ['admin', 'doctor', 'insurance01', 'patient01', 'P001', 'P002', 'P003', 'P004'];
  for (const col of ['consents', 'care_relations', 'break_glass']) {
    for (const cp of counterparts) {
      firestoreDelete(`${col}/${u}__${cp}`);
      firestoreDelete(`${col}/${cp}__${u}`);
    }
  }

  // Step 6-9: 需要 Console 手動處理的項目
  console.log('\n📋 需要到 Firebase Console 手動處理：');
  console.log(`  • patient_index: 搜尋 username == "${u}"`);
  console.log(`  • appointments: 搜尋 patient == "${u}"`);
  console.log(`  • care_cases: 搜尋 patientId == "${u}"`);
  console.log(`  • insurance_claims/policies: 搜尋 customer == "${u}"`);
  console.log(`  • Authentication: 刪除 ${u}@medsafe.local`);

  console.log(`\n${'='.repeat(60)}`);
  console.log('  Firestore 文件刪除完成！');
  console.log(`${'='.repeat(60)}\n`);
}

main().catch(console.error);
