// routes/admin_upload.js
const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// ✅ 初始化 Firebase（確保只初始化一次）
if (!admin.apps.length) {
  const serviceAccount = require('../serviceAccountKey.json'); // 請放在根目錄
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

router.get('/upload-body-parts', async (req, res) => {
  try {
    const jsonPath = path.join(__dirname, '../body_parts.json');
    const bodyParts = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    const batch = db.batch();
    bodyParts.forEach((part) => {
      const docId = part.part_id || part.id || db.collection('body_parts').doc().id;
      const docRef = db.collection('body_parts').doc(docId);
      batch.set(docRef, part);
    });

    await batch.commit();
    res.send('✅ 上傳成功，共匯入 ' + bodyParts.length + ' 筆資料');
  } catch (err) {
    console.error(err);
    res.status(500).send('❌ 上傳失敗：' + err.message);
  }
});

module.exports = router;
