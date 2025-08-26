// scripts/upload_symptoms_to_firestore.js

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// ✅ 初始化 Firestore（建議使用環境變數）
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// ✅ 載入 symptoms_by_location.json
const dataPath = path.join(__dirname, '../data/symptoms_by_location.json');
const symptomsData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

async function uploadSymptoms() {
  const batch = db.batch();

  for (const [locationId, symptoms] of Object.entries(symptomsData)) {
    const ref = db.collection('symptoms_by_location').doc(locationId);
    batch.set(ref, { symptoms });
  }

  await batch.commit();
  console.log('✅ 症狀已成功上傳至 Firestore（symptoms_by_location collection）');
}

uploadSymptoms().catch(console.error);
