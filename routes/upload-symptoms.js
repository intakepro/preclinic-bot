const express = require('express');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const router = express.Router();
router.get('/upload-symptoms-master', async (req, res) => {
  try {
    if (req.query.key !== process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
      return res.status(403).send('Forbidden');
    }
    const filePath = path.join(__dirname, '..', 'data', 'symptoms_by_location.json');
    const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const db = admin.firestore();
    const batch = db.batch();

    json.forEach(row => {
      const ref = db.collection('symptoms').doc(String(row.id));
      batch.set(ref, {
        name_zh: row.name_zh || row.name_en || row.id,
        name_en: row.name_en || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });

    await batch.commit();
    res.send(`✅ Uploaded ${json.length} symptoms to master 'symptoms' collection.`);
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + (e.message || e));
  }
});

module.exports = router;