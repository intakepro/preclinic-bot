// routes/clear_symptom_questions.js
// Version: v1.1.0-envkey
// 功能：清空 symptom_questions collection，支援用環境變數保護

const express = require('express');
const admin = require('firebase-admin');

const router = express.Router();
const db = admin.firestore();

// ✅ 從環境變數讀取密碼（Render > Environment > ADMIN_KEY）
// ✅ 預設 fallback 是 '1234'
const ADMIN_KEY = process.env.ADMIN_KEY || '1234';

router.get('/clear-symptom-questions', async (req, res) => {
  const key = req.query.key;
  if (key !== ADMIN_KEY) {
    return res.status(401).send('❌ 未授權：請提供正確密碼 ?key=xxx');
  }

  try {
    const snapshot = await db.collection('symptom_questions').get();

    if (snapshot.empty) {
      return res.send('ℹ️ symptom_questions 已經是空的');
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    res.send(`✅ 成功刪除 ${snapshot.size} 筆 symptom_questions`);
  } catch (err) {
    console.error('❌ 清除錯誤:', err);
    res.status(500).send('❌ 無法刪除 symptom_questions');
  }
});

module.exports = router;