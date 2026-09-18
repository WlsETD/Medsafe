// 刪除錯誤的 family 綁定
const admin = require('firebase-admin');

const serviceAccount = require('./.firebase/service-account-key.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'medsafe-554b7'
});

const db = admin.firestore();

(async () => {
  try {
    // 1. 查詢 line_bindings 中的錯誤記錄，取得 lineUserId
    const bindingDoc = await db.collection('line_bindings').doc('family_ea133217b744').get();
    if (!bindingDoc.exists) {
      console.log('找不到 line_bindings/family_ea133217b744，可能已刪除');
      process.exit(0);
    }

    const { lineUserId } = bindingDoc.data();
    console.log('找到 lineUserId:', lineUserId);

    // 2. 刪除 line_bindings 記錄
    await db.collection('line_bindings').doc('family_ea133217b744').delete();
    console.log('✓ 刪除 line_bindings/family_ea133217b744');

    // 3. 刪除 line_users 記錄
    if (lineUserId) {
      await db.collection('line_users').doc(lineUserId).delete();
      console.log('✓ 刪除 line_users/' + lineUserId);
    }

    // 4. 刪除 line_link_codes 中該 username 相關的任何記錄
    const codesSnapshot = await db.collection('line_link_codes')
      .where('username', '==', 'family_ea133217b744').get();
    for (const doc of codesSnapshot.docs) {
      await doc.ref.delete();
      console.log('✓ 刪除 line_link_codes/' + doc.id);
    }

    console.log('\n完成！family_ea133217b744 的 LINE 綁定已清除。');
    console.log('現在可以用你的患者帳號重新綁定 LINE。');

    process.exit(0);
  } catch (e) {
    console.error('錯誤:', e.message);
    process.exit(1);
  }
})();
