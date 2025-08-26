// scripts/upload_body_parts_to_firestore.js
// Version: v1.0.0
// 功能：將 data/body_parts_tree.json 上傳到 Firestore 的 body_parts_tree/full_tree 文件

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// ✅ 初始化 Firestore（請確保 FIREBASE_SERVICE_ACCOUNT 環境變數已設定）
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// ✅ 載入 JSON 資料（來自 data/body_parts_tree.json）
const dataPath = path.join(__dirname, '../data/body_parts_tree.json');

if (!fs.existsSync(dataPath)) {
  console.error('❌ 找不到 body_parts_tree.json，請確認檔案是否存在於 /data 資料夾內');
  process.exit(1);
}

const bodyPartsTree = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

async function uploadBodyParts() {
  const ref = db.collection('body_parts_tree').doc('full_tree');
  await ref.set({ tree: bodyPartsTree });

  console.log('✅ 成功上傳 body_parts_tree 至 Firestore: collection=body_parts_tree, doc=full_tree');
}

uploadBodyParts().catch((err) => {
  console.error('❌ 上傳失敗：', err);
});