// upload_body_parts.js
// 功能：將 body_parts.json 上傳至 Firestore
// 版本：v1.0.0

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// 🔐 請確認此檔案存在，並為你的 Firebase service account 憑證
const serviceAccount = require('./serviceAccountKey.json');

// ✅ 初始化 Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// 📁 載入 JSON 資料
const jsonPath = path.join(__dirname, 'body_parts.json');
const bodyParts = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

// 📤 上傳至 Firestore
async function uploadBodyParts() {
  console.log(`🚀 開始上傳 ${bodyParts.length} 筆部位資料到 Firestore...`);

  const batch = db.batch();

  bodyParts.forEach((part) => {
    const docId = part.part_id || part.id || db.collection('body_parts').doc().id;
    const docRef = db.collection('body_parts').doc(docId);
    batch.set(docRef, part);
  });

  await batch.commit();
  console.log('✅ 上傳完成！');
}

uploadBodyParts().catch(console.error);