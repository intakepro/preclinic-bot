// modules/interview/location.js
// Version: v1.0.0
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

function toArrayTexts(out) {
  if (!out) return [];
  if (Array.isArray(out.texts)) return out.texts.filter(t => typeof t === 'string' && t.trim());
  if (typeof out.text === 'string' && out.text.trim()) return [out.text];
  return [];
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
  if (!snap.exists) {
    return {};
  }
  return snap.data() || {};
}

async function handle({ from, msg }) {
  const session = await getSession(from);
  const selectedIndex = parseInt(msg?.trim(), 10);

  const parts = await getLevelOneBodyParts();

  if (!session._locationStep) {
    // 初次顯示選單
    await setSession(from, { _locationStep: 'awaiting' });
    return {
      text: `📍 請選擇你不適的身體部位：\n\n${formatOptions(parts)}\n\n請輸入數字選項，例如：1`
    };
  }

  if (msg.trim() === '0') {
    // 使用者選擇返回上一題
    await setSession(from, { _locationStep: admin.firestore.FieldValue.delete() });
    return {
      text: '↩️ 已返回上一題。請重新開始選擇部位。',
      done: false
    };
  }

  if (isNaN(selectedIndex) || selectedIndex < 1 || selectedIndex > parts.length) {
    return {
      text: `⚠️ 請輸入有效數字，例如：1 ~ ${parts.length}`
    };
  }

  const selected = parts[selectedIndex - 1];

  // 儲存選擇
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
    text: `✅ 你選擇的是：${selected.name_zh}\n我們會繼續進行問診。`,
    done: true
  };
}

module.exports = { handle };