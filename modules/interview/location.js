// modules/interview/location.js
// Version: v1.1.0
// 功能：顯示第一層身體部位，供病人選擇，並儲存至 Firestore 的 session 資料中

const admin = require('firebase-admin');
const db = admin.firestore();

const COLLECTION = 'body_parts_tree';
const SESSION_COLLECTION = 'sessions';

async function getLevelOneBodyParts() {
  const snap = await db.collection(COLLECTION)
    .where('level', '==', 1)
    .orderBy('sort_order')
    .get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

function formatOptions(parts) {
  return parts.map((p, i) => `${i + 1}. ${p.name_zh}`).join('\n');
}

async function setSession(from, patch) {
  const key = (from || '').toString().replace(/^whatsapp:/i, '').trim();
  const ref = db.collection(SESSION_COLLECTION).doc(key);
  await ref.set({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

async function getSession(from) {
  const key = (from || '').toString().replace(/^whatsapp:/i, '').trim();
  const ref = db.collection(SESSION_COLLECTION).doc(key);
  const snap = await ref.get();
  return snap.exists ? (snap.data() || {}) : {};
}

async function handleLocation({ from, msg }) {
  const session = await getSession(from);
  const parts = await getLevelOneBodyParts();
  const cleanMsg = (msg || '').trim();

  // ➤ 第一次顯示身體部位選單
  if (!session._locationStep) {
    await setSession(from, { _locationStep: 'awaiting' });
    return {
      texts: [
        '📍 請選擇你不適的身體部位：',
        formatOptions(parts),
        '請輸入數字選項，例如：1'
      ],
      done: false
    };
  }

  // ➤ 回上一題
  if (cleanMsg === '0') {
    await setSession(from, { _locationStep: admin.firestore.FieldValue.delete() });
    return {
      texts: [
        '↩️ 已返回上一題。',
        '請重新選擇你不適的身體部位。'
      ],
      done: false
    };
  }

  const selectedIndex = parseInt(cleanMsg, 10);

  if (isNaN(selectedIndex) || selectedIndex < 1 || selectedIndex > parts.length) {
    return {
      texts: [`⚠️ 請輸入有效數字，例如：1 ~ ${parts.length}`],
      done: false
    };
  }

  const selected = parts[selectedIndex - 1];

  // ➤ 儲存選擇結果
  await setSession(from, {
    selectedLocation: {
      id: selected.id,
      name_zh: selected.name_zh,
      level: selected.level,
      full_path: selected.full_path || selected.name_zh
    },
    _locationStep: admin.firestore.FieldValue.delete()
  });

  return {
    texts: [
      `✅ 你選擇的是：${selected.name_zh}`,
      '我們會繼續進行問診。'
    ],
    done: true
  };
}

module.exports = { handleLocation };