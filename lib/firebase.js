// lib/firebase.js
// 統一初始化 firebase-admin，支援兩種做法：
// A) 直接在 Render 設定環境變數 GCP_SA_KEY_JSON=整段 service account JSON
// B) 或者設 GOOGLE_APPLICATION_CREDENTIALS 指向 JSON 檔路徑（container 內）

const admin = require('firebase-admin');

if (!admin.apps.length) {
  try {
    if (process.env.GCP_SA_KEY_JSON) {
      const sa = JSON.parse(process.env.GCP_SA_KEY_JSON);
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        projectId: sa.project_id
      });
      console.log('[firebase] initialized with GCP_SA_KEY_JSON');
    } else {
      // 走 Application Default Credentials（需要設好 GOOGLE_APPLICATION_CREDENTIALS）
      admin.initializeApp();
      console.log('[firebase] initialized with default credentials');
    }
  } catch (e) {
    console.error('[firebase] init error:', e);
    throw e;
  }
}

module.exports = admin;
