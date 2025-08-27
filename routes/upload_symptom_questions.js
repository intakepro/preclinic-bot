// routes/upload_symptom_questions.js
// Version: v1.0.0
// 功能：讀取 data/symptom_questions_all.json 檔案，逐筆寫入 Firestore 的 symptom_questions collection

const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const db = admin.firestore();

router.get('/upload-symptom-questions', async (req, res) => {
  try {
    const filePath = path.join(__dirname, '../data/symptom_questions_all.json');
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('❌ 找不到 symptom_questions_all.json 檔案');
    }

    const fileContent = fs.readFileSync(filePath, 'utf8');
    const symptoms = JSON.parse(fileContent);

    let uploadedCount = 0;

    for (const item of symptoms) {
      if (!item.symptom_id || !item.questions) continue;

      await db.collection('symptom_questions').doc(item.symptom_id).set({
        symptom_id: item.symptom_id,
        questions: item.questions,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      uploadedCount++;
    }

    res.send(`✅ 成功上傳 ${uploadedCount} 個 symptom_questions`);
  } catch (error) {
    console.error('❌ 上傳 symptom_questions 發生錯誤:', error);
    res.status(500).send('❌ 上傳 symptom_questions 發生錯誤');
  }
});

module.exports = router;