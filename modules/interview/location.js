// modules/interview/location.js
// Version: v1.2.0
// 功能：支援多層選擇身體部位直到最底層

const admin = require('firebase-admin');
const db = admin.firestore();

const COLLECTION = 'body_parts_tree';
const SESSION_COLLECTION = 'sessions';

// 🔍 讀取某個 parentId 下的子節點
async function getChildrenParts(parentId) {
  const ref = db.collection(COLLECTION);
  const query = parentId
    ? ref.where('parent_id', '==', parentId).orderBy('sort_order')
    : ref.where('level', '==', 1).orderBy('sort_order');
  const snap = await query.get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// 🔢 格式化選單（1. 項目）
function formatOptions(parts) {
  return parts.map((p, i) => `${i + 1}. ${p.name_zh}`).join('\n');
}

// 🔐 從 from 中取出電話號碼作為 session ID
function getSessionId(from) {
  return (from || '').toString().replace(/^whatsapp:/i, '').trim();
}

// 🧠 讀取 session
async function getSession(from) {
  const id = getSessionId(from);
  const ref = db.collection(SESSION_COLLECTION).doc(id);
  const snap = await ref.get();
  return snap.exists ? snap.data() : {};
}

// 💾 寫入 session
async function setSession(from, patch) {
  const id = getSessionId(from);
  const ref = db.collection(SESSION_COLLECTION).doc(id);
  await ref.set({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

// 🧩 核心處理邏輯
async function handleLocation({ from, msg }) {
  const session = await getSession(from);
  const path = session.selectedLocationPath || [];

  // 當前所在的 parentId 是 path 最後一項（如果有）
  const currentParentId = path.length > 0 ? path[path.length - 1].id : null;
  const parts = await getChildrenParts(currentParentId);

  // 初次或等待選擇 → 顯示選單
  if (!session._locationStep || session._locationStep === 'awaiting') {
    await setSession(from, { _locationStep: 'selecting' });
    return {
      text: `📍 請選擇你不適的身體部位：\n\n${formatOptions(parts)}\n\n請輸入數字選項，例如：1`
    };
  }

  // 解析使用者輸入的選項
  const selectedIndex = parseInt(msg?.trim(), 10);
  if (isNaN(selectedIndex) || selectedIndex < 1 || selectedIndex > parts.length) {
    return { text: `⚠️ 請輸入有效數字，例如：1 ~ ${parts.length}` };
  }

  const selected = parts[selectedIndex - 1];
  const newPath = [...path, selected];

  // 判斷是否還有下一層
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

  // 沒有下一層 → 到底了
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