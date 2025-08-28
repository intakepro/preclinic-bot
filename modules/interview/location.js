// modules/interview/location.js
// Version: v2.0.0
// 支援多層身體部位選單，逐層選擇直到沒有下一層為止。

const admin = require('firebase-admin');
const db = admin.firestore();

const COLLECTION = 'body_parts_tree';
const SESSION_COLLECTION = 'sessions';

function formatOptions(parts) {
  return parts.map((p, i) => `${i + 1}. ${p.name_zh}`).join('\n');
}

async function getPartsByParent(parentId) {
  const query = parentId
    ? db.collection(COLLECTION).where('parent_id', '==', parentId).orderBy('sort_order')
    : db.collection(COLLECTION).where('level', '==', 1).orderBy('sort_order');

  const snap = await query.get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function setSession(from, patch) {
  const key = from.replace(/^whatsapp:/, '').trim();
  await db.collection(SESSION_COLLECTION).doc(key).set(
    { ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

async function getSession(from) {
  const key = from.replace(/^whatsapp:/, '').trim();
  const snap = await db.collection(SESSION_COLLECTION).doc(key).get();
  return snap.exists ? snap.data() : {};
}

async function handle({ from, msg }) {
  const session = await getSession(from);
  const selectedIndex = parseInt(msg?.trim(), 10);

  const currentPath = session._locationPath || [];
  const parentId = currentPath.length > 0 ? currentPath[currentPath.length - 1].id : null;

  const parts = await getPartsByParent(parentId);

  // 初次顯示或尚未選擇
  if (!session._locationStep || session._locationStep === 'awaiting') {
    await setSession(from, { _locationStep: 'awaiting', _locationPath: currentPath });
    return {
      text: `📍 請選擇你不適的身體部位：\n\n${formatOptions(parts)}\n\n請輸入數字選項，例如：1`
    };
  }

  if (msg.trim() === '0') {
    // 回上一層
    currentPath.pop();
    const step = currentPath.length > 0 ? 'awaiting' : null;
    await setSession(from, { _locationStep: step, _locationPath: currentPath });
    return {
      text: '↩️ 已返回上一層，請重新選擇。',
      done: false
    };
  }

  if (isNaN(selectedIndex) || selectedIndex < 1 || selectedIndex > parts.length) {
    return {
      text: `⚠️ 請輸入有效數字，例如：1 ~ ${parts.length}`
    };
  }

  const selected = parts[selectedIndex - 1];
  currentPath.push({
    id: selected.id,
    name_zh: selected.name_zh,
    level: selected.level,
    full_path: selected.full_path || selected.name_zh
  });

  const children = await getPartsByParent(selected.id);
  if (children.length > 0) {
    // 還有下一層，繼續選
    await setSession(from, { _locationStep: 'awaiting', _locationPath: currentPath });
    return {
      text: `📍 請繼續選擇更細部位：\n\n${formatOptions(children)}\n\n請輸入數字選項，例如：1`
    };
  } else {
    // 沒有下一層，選擇完成
    const finalSelection = currentPath[currentPath.length - 1];
    await setSession(from, {
      selectedLocation: finalSelection,
      _locationStep: admin.firestore.FieldValue.delete(),
      _locationPath: admin.firestore.FieldValue.delete()
    });
    return {
      text: `✅ 你選擇的是：${finalSelection.full_path}\n我們會繼續進行問診。`,
      done: true
    };
  }
}

module.exports = { handle };