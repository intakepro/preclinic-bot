// 路由：/admin/upload-symptoms
// 功能：將本機 symptoms_by_location.json 上傳到 Firestore
// 版本：v1.0.0
// 日期：2025-08-26

const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// 初始化 Firebase（如尚未初始化）
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

router.get('/upload-symptoms', async (req, res) => {
  try {
    const filePath = path.join(__dirname, '../data/symptoms_by_location.json');
    const rawData = fs.readFileSync(filePath);
    const symptomsData = JSON.parse(rawData);

    const batch = db.batch();
    const collectionRef = db.collection('symptoms_by_location');

    let count = 0;
    for (const locationId in symptomsData) {
      const docRef = collectionRef.doc(locationId);
      batch.set(docRef, { symptoms: symptomsData[locationId] });
      count++;
    }

    await batch.commit();
    res.send(`✅ 成功上傳 ${count} 個部位的病徵清單到 Firestore`);
  } catch (error) {
    console.error('❌ 上傳錯誤:', error);
    res.status(500).send('❌ 上傳失敗，請檢查 server log');
  }
});

module.exports = router;