// routes/clear_symptom_questions.js
// Version: v1.0.0
// 功能：清空 Firestore 裡的 symptom_questions collection（需提供密碼）

const express = require('express');
const admin = require('firebase-admin');

const router = express.Router();
const db = admin.firestore();

// ✅ 安全保護：需要提供 ?key=你的密碼
const ADMIN_KEY = '1234'; // 可自訂密碼

router.get('/clear-symptom-questions', async (req, res) => {
  const key = req.query.key;
  if (key !== ADMIN_KEY) {
    return res.status(401).send('❌ 未授權：請提供正確密碼 ?key=1234');
  }

  try {
    const snapshot = await db.collection('symptom_questions').get();
    if (snapshot.empty) {
      return res.send('ℹ️ symptom_questions 已經是空的');
    }

    let deleted = 0;
    const batch = db.batch();

    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
      deleted++;
    });

    await batch.commit();
    res.send(`✅ 成功刪除 ${deleted} 筆 symptom_questions`);
  } catch (err) {
    console.error('❌ 清除錯誤:', err);
    res.status(500).send('❌ 無法刪除 symptom_questions');
  }
});

module.exports = router;