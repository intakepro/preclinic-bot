// modules/interview/location.js
// Version: v1.2.1  (add index-safe fallback)

const admin = require('firebase-admin');
const db = admin.firestore();

const COLLECTION = 'body_parts_tree';
const SESSIONS   = 'sessions';

const keyOf = (from) => (from || '').toString().replace(/^whatsapp:/i, '').trim();

async function getSession(from) {
  const ref = db.collection(SESSIONS).doc(keyOf(from));
  const snap = await ref.get();
  return snap.exists ? (snap.data() || {}) : {};
}
async function setSession(from, patch) {
  const ref = db.collection(SESSIONS).doc(keyOf(from));
  await ref.set({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

// ⬇️ 索引安全的子節點查詢
async function getChildrenSafe(parentId) {
  const col = db.collection(COLLECTION);
  try {
    let q = parentId ? col.where('parent_id', '==', parentId)
                     : col.where('level', '==', 1);
    q = q.orderBy('sort_order');
    const snap = await q.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    const msg = String(e && e.message || '');
    // 索引未建好 → 降級處理：不排序查詢 + 內存排序
    if (e.code === 9 || msg.includes('FAILED_PRECONDITION') || msg.includes('requires an index')) {
      console.warn('[location] Missing index, using fallback sort in memory.');
      const q = parentId ? col.where('parent_id', '==', parentId)
                         : col.where('level', '==', 1);
      const snap = await q.get();
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      rows.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      return rows;
    }
    throw e; // 其他錯誤照拋
  }
}

const fmt = (parts, showBack) => {
  const lines = parts.map((p, i) => `${i + 1}. ${p.name_zh}`);
  if (showBack) lines.push('0. ↩️ 返回上一層');
  return lines.join('\n');
};

async function handleLocation({ from, msg }) {
  const ses = await getSession(from);
  const path = Array.isArray(ses.selectedLocationPath) ? ses.selectedLocationPath : [];
  const parentId = path.length ? path[path.length - 1].id : null;

  const parts = await getChildrenSafe(parentId);

  const raw = (msg || '').trim();
  const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;

  // 0 = 返回上一層
  if (!Number.isNaN(n) && n === 0 && path.length > 0) {
    const newPath = path.slice(0, -1);
    await setSession(from, { selectedLocationPath: newPath });
    const pid = newPath.length ? newPath[newPath.length - 1].id : null;
    const siblings = await getChildrenSafe(pid);
    return { text: `↩️ 已返回上一層。\n請選擇：\n\n${fmt(siblings, newPath.length > 0)}\n\n請輸入數字，例如：1` };
  }

  // 1..N 有效選擇
  if (!Number.isNaN(n) && n >= 1 && n <= parts.length) {
    const selected = parts[n - 1];
    const newPath = [...path, selected];
    const kids = await getChildrenSafe(selected.id);

    if (kids.length > 0) {
      await setSession(from, { selectedLocationPath: newPath });
      return { text: `📍 你選擇的是：${selected.name_zh}\n請選擇更細部位：\n\n${fmt(kids, true)}\n\n請輸入數字，例如：1` };
    }

    // 最底層
    await setSession(from, { selectedLocationPath: newPath, finalLocation: selected });
    return { text: `✅ 你選擇的是：${selected.name_zh}，我們會繼續問診。`, done: true, finalLocation: selected };
  }

  // 非有效輸入 → 顯示本層
  return { text: `📍 請選擇你不適的身體部位：\n\n${fmt(parts, path.length > 0)}\n\n請輸入數字，例如：1` };
}

module.exports = { handleLocation };