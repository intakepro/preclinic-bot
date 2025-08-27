// routes/upload_symptom_questions.js
// Version: v1.1.1-safe
// 功能：讀取 symptom_questions_all.json，寫入 Firestore（自動處理非法路徑符號）

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

    const content = fs.readFileSync(filePath, 'utf8');
    const symptoms = JSON.parse(content);

    let uploaded = 0;

    for (const item of symptoms) {
      if (!item.symptom_id || !item.questions) continue;

      // ✅ 將 symptom_id 中的 `/` 換成 `-`，避免 Firestore 錯誤
      const safeDocId = item.symptom_id.replace(/\//g, '-');

      await db.collection('symptom_questions').doc(safeDocId).set({
        symptom_id: item.symptom_id, // 保留原始名稱
        questions: item.questions,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      uploaded++;
    }

    res.send(`✅ 成功上傳 ${uploaded} 筆 symptom_questions`);
  } catch (err) {
    console.error('❌ 上傳 symptom_questions 發生錯誤:', err);
    res.status(500).send('❌ 上傳 symptom_questions 發生錯誤');
  }
});

module.exports = router;