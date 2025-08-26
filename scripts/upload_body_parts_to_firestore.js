// scripts/upload_body_parts_to_firestore.js

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// ✅ 初始化 Firestore（如已在 index.js 初始化可共用）
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// ✅ 載入部位 JSON 資料
const dataPath = path.join(__dirname, '../data/body_parts_tree.json');
const bodyPartsTree = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

async function uploadBodyParts() {
  const ref = db.collection('body_parts_tree').doc('full_tree');
  await ref.set({ tree: bodyPartsTree });

  console.log('✅ body_parts_tree 已成功上傳至 Firestore！');
}

uploadBodyParts().catch(console.error);
