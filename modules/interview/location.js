// modules/interview/location.js
// Version: v1.1.2
// 修正：session 沒有正確讀取與傳遞更新問題，導致無限重複 Level 1；加入 debug 訊息

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

async function getSession(from) {
  const key = getKey(from);
  const ref = db.collection(SESSION_COLLECTION).doc(key);
  const snap = await ref.get();
  return snap.exists ? snap.data() : {};
}

async function handleLocation({ from, msg }) {
  // ✅ 每次強制從 Firestore 抓最新 session，避免使用舊值
  const session = await getSession(from);
  const path = session.selectedLocationPath || [];
  const currentParentId = path.length > 0 ? path[path.length - 1].id : null;

  const parts = await getChildrenParts(currentParentId);

  console.log(`[location] 現在 parent_id=${currentParentId}，找到子項數量=${parts.length}`);

  // 初次顯示或等待選擇
  if (!session._locationStep || session._locationStep === 'awaiting') {
    return {
      text: `📍 請選擇你不適的身體部位：\n\n${formatOptions(parts)}\n\n請輸入數字選項，例如：1`,
      sessionUpdates: { _locationStep: 'selecting' }
    };
  }

  const selectedIndex = parseInt(msg?.trim(), 10);
  if (isNaN(selectedIndex) || selectedIndex < 1 || selectedIndex > parts.length) {
    return {
      text: `⚠️ 請輸入有效數字，例如：1 ~ ${parts.length}`,
      sessionUpdates: {} // ❗不更新 session
    };
  }

  const selected = parts[selectedIndex - 1];
  const newPath = [...path, selected];

  const children = await getChildrenParts(selected.id);
  if (children.length > 0) {
    console.log(`[location] 你選擇 ${selected.name_zh}，還有子項，繼續下探`);
    return {
      text: `📍 你選擇的是：${selected.name_zh}\n請選擇更細的部位：\n\n${formatOptions(children)}\n\n請輸入數字選項，例如：1`,
      sessionUpdates: {
        selectedLocationPath: newPath,
        _locationStep: 'awaiting'
      }
    };
  }

  // ✅ 最底層，結束 location 模組
  console.log(`[location] 你選擇 ${selected.name_zh}，已是最底層`);
  return {
    text: `✅ 你選擇的是：${selected.name_zh}，我們會繼續問診。`,
    done: true,
    sessionUpdates: {
      selectedLocationPath: newPath,
      finalLocation: selected,
      _locationStep: admin.firestore.FieldValue.delete()
    }
  };
}

module.exports = { handleLocation };