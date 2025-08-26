// scripts/upload_body_parts_to_firestore.js
const admin = require('firebase-admin');
const bodyPartsData = require('../data/body_parts_tree.json');

module.exports = async function uploadBodyPartsToFirestore() {
  const db = admin.firestore();
  const batch = db.batch();

  for (const item of bodyPartsData) {
    const docRef = db.collection('body_parts').doc(item.id); // 建議使用 item.id 為主鍵
    batch.set(docRef, item);
  }

  await batch.commit();
  console.log('✅ Body parts uploaded to Firestore.');
};