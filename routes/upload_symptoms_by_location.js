const express = require('express');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const router = express.Router();
router.get('/upload-symptoms-by-location', async (req, res) => {
  try {
    if (req.query.key !== process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
      return res.status(403).send('Forbidden');
    }
    const filePath = path.join(__dirname, '..', 'data', 'symptoms_by_location.json');
    const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const db = admin.firestore();
    const batch = db.batch();

    json.forEach(item => {
      const ref = db.collection('symptoms_by_location').doc(String(item.location_id));
      batch.set(ref, {
        location_name_zh: item.location_name_zh || null,
        symptoms: Array.isArray(item.symptoms) ? item.symptoms : [],
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });

    await batch.commit();
    res.send(`✅ Uploaded ${json.length} locations to symptoms_by_location.`);
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + (e.message || e));
  }
});

module.exports = router;