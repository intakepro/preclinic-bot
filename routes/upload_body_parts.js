// routes/upload_body_parts.js
// 功能：透過網址路由觸發上傳 body_parts_tree_fixed_final.json 到 Firestore

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const bodyPartsData = require('../data/body_parts_tree_fixed_final.json'); // ✅ 確保路徑正確

router.get('/upload-body-parts', async (req, res) => {
  try {
    const db = admin.firestore();
    const batch = db.batch();

    for (const item of bodyPartsData) {
      const docRef = db.collection('body_parts_tree').doc(item.id);
      batch.set(docRef, item);
    }

    await batch.commit();
    res.send('✅ Body parts uploaded to Firestore.');
  } catch (error) {
    console.error('❌ 上傳失敗:', error);
    res.status(500).send('❌ 上傳失敗：' + error.message);
  }
});

module.exports = router;