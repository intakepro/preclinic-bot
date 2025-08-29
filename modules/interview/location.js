// modules/interview/location.js
// Version: v1.2.0
// 功能：多層選擇直到最底層；移除容易造成循環的狀態陷阱；支援 0 返回上一層

const admin = require('firebase-admin');
const db = admin.firestore();

const COLLECTION = 'body_parts_tree';
const SESSION_COLLECTION = 'sessions';

function keyOf(from) {
  return (from || '').toString().replace(/^whatsapp:/i, '').trim();
}

async function getSession(from) {
  const ref = db.collection(SESSION_COLLECTION).doc(keyOf(from));
  const snap = await ref.get();
  return snap.exists ? (snap.data() || {}) : {};
}

async function setSession(from, patch) {
  const ref = db.collection(SESSION_COLLECTION).doc(keyOf(from));
  await ref.set({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

async function getChildrenParts(parentId) {
  const col = db.collection(COLLECTION);
  const q = parentId
    ? col.where('parent_id', '==', parentId).orderBy('sort_order')
    : col.where('level', '==', 1).orderBy('sort_order');
  const snap = await q.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function formatOptions(parts, withBack) {
  const lines = parts.map((p, i) => `${i + 1}. ${p.name_zh}`);
  if (withBack) lines.push('0. ↩️ 返回上一層');
  return lines.join('\n');
}

async function handleLocation({ from, msg }) {
  // 取得目前路徑
  const session = await getSession(from);
  const path = Array.isArray(session.selectedLocationPath) ? session.selectedLocationPath : [];

  // 目前要顯示的 options（root 或上一次選的最後一個節點的子層）
  const currentParentId = path.length ? path[path.length - 1].id : null;
  const parts = await getChildrenParts(currentParentId);

  // 解析輸入（數字才處理，其他一律視為要顯示選單）
  const raw = (msg || '').trim();
  const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;

  // 0 = 返回上一層（僅當非 root 才有意義）
  if (!Number.isNaN(n) && n === 0 && path.length > 0) {
    const newPath = path.slice(0, -1);
    await setSession(from, { selectedLocationPath: newPath });
    const parentId = newPath.length ? newPath[newPath.length - 1].id : null;
    const siblings = await getChildrenParts(parentId);
    return {
      text: `↩️ 已返回上一層。\n請選擇：\n\n${formatOptions(siblings, newPath.length > 0)}\n\n請輸入數字選項，例如：1`
    };
  }

  // 有效的選擇（1..parts.length）
  if (!Number.isNaN(n) && n >= 1 && n <= parts.length) {
    const selected = parts[n - 1];
    const newPath = [...path, selected];
    const children = await getChildrenParts(selected.id);

    if (children.length > 0) {
      // 還有下一層 → 繼續選
      await setSession(from, { selectedLocationPath: newPath });
      return {
        text: `📍 你選擇的是：${selected.name_zh}\n請選擇更細的部位：\n\n${formatOptions(children, true)}\n\n請輸入數字選項，例如：1`
      };
    }

    // 沒有下一層 → 完成 location
    await setSession(from, {
      selectedLocationPath: newPath,
      finalLocation: selected
    });
    return {
      text: `✅ 你選擇的是：${selected.name_zh}，我們會繼續問診。`,
      done: true
    };
  }

  // 非有效輸入 → 顯示目前層選單（root 無返回鍵、非 root 顯示返回鍵）
  return {
    text: `📍 請選擇你不適的身體部位：\n\n${formatOptions(parts, path.length > 0)}\n\n請輸入數字選項，例如：1`
  };
}

module.exports = { handleLocation };
