// modules/interview/location.js
// Version: v1.1.1
// 功能：支援多層選擇身體部位直到最底層，修正 session 傳入問題

const admin = require('firebase-admin');
const db = admin.firestore();

const COLLECTION = 'body_parts_tree';
const SESSION_COLLECTION = 'sessions';

async function getChildrenParts(parentId) {
  const ref = db.collection(COLLECTION);
  const query = parentId
    ? ref.where('parent_id', '==', parentId).orderBy('sort_order')
    : ref.where('level', '==', 1).orderBy('sort_order');
  const snap = await query.get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

function formatOptions(parts) {
  return parts.map((p, i) => `${i + 1}. ${p.name_zh}`).join('\n');
}

function getKey(from) {
  return (from || '').toString().replace(/^whatsapp:/i, '').trim();
}

async function setSession(from, patch) {
  const key = getKey(from);
  const ref = db.collection(SESSION_COLLECTION).doc(key);
  await ref.set({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

async function getSession(from) {
  const key = getKey(from);
  const ref = db.collection(SESSION_COLLECTION).doc(key);
  const snap = await ref.get();
  return snap.exists ? snap.data() : {};
}

async function handleLocation({ from, msg, session, db }) {
  session = session || {};

  const path = session.selectedLocationPath || [];
  const currentParentId = path.length > 0 ? path[path.length - 1].id : null;

  const parts = await getChildrenParts(currentParentId);

  // 初次顯示或等待選擇
  if (!session._locationStep || session._locationStep === 'awaiting') {
    await setSession(from, { _locationStep: 'selecting' });
    return {
      text: `📍 請選擇你不適的身體部位：\n\n${formatOptions(parts)}\n\n請輸入數字選項，例如：1`
    };
  }

  const selectedIndex = parseInt(msg?.trim(), 10);
  if (isNaN(selectedIndex) || selectedIndex < 1 || selectedIndex > parts.length) {
    return { text: `⚠️ 請輸入有效數字，例如：1 ~ ${parts.length}` };
  }

  const selected = parts[selectedIndex - 1];
  const newPath = [...path, selected];

  // 查下一層是否還有子項目
  const children = await getChildrenParts(selected.id);
  if (children.length > 0) {
    await setSession(from, {
      selectedLocationPath: newPath,
      _locationStep: 'awaiting'
    });
    return {
      text: `📍 你選擇的是：${selected.name_zh}\n請選擇更細的部位：\n\n${formatOptions(children)}\n\n請輸入數字選項，例如：1`
    };
  }

  // 到最底層了，結束 location
  await setSession(from, {
    selectedLocationPath: newPath,
    finalLocation: selected,
    _locationStep: admin.firestore.FieldValue.delete()
  });

  return {
    text: `✅ 你選擇的是：${selected.name_zh}，我們會繼續問診。`,
    done: true
  };
}

module.exports = { handleLocation };