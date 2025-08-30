// modules/interview/location.js
// Version: v1.3.0 (stable)
// 功能：多層身體部位選擇直到最底層；支援返回、重置；索引欠缺自動 fallback。
// 需要的 Firestore 索引（建議正式環境建立）：
//   1) body_parts_tree: level ASC, sort_order ASC   （第一層）
//   2) body_parts_tree: parent_id ASC, sort_order ASC（第二層起）

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
  await ref.set(
    { ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

// 取得子節點（有索引先用 orderBy，沒有索引就降級為不排序查詢 + 內存排序）
async function getChildrenSafe(parentId) {
  const col = db.collection(COLLECTION);
  try {
    let q = parentId
      ? col.where('parent_id', '==', parentId)
      : col.where('level', '==', 1);
    q = q.orderBy('sort_order');
    const snap = await q.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    const msg = String(e && e.message || '');
    if (e.code === 9 || msg.includes('FAILED_PRECONDITION') || msg.includes('requires an index')) {
      console.warn('[location] Missing index, use in-memory sort fallback.');
      const q = parentId
        ? col.where('parent_id', '==', parentId)
        : col.where('level', '==', 1);
      const snap = await q.get();
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      rows.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      return rows;
    }
    throw e;
  }
}

const fmt = (parts, showBack) => {
  const lines = parts.map((p, i) => `${i + 1}. ${p.name_zh || p.name || p.id}`);
  if (showBack) lines.push('0. ↩️ 返回上一層');
  return lines.join('\n');
};

/**
 * 入口：由 interview.js 呼叫
 * @param {{from:string, msg:string}} param0
 * @returns {{text:string, done?:boolean, finalLocation?:any}}
 */
async function handleLocation({ from, msg }) {
  const ses = await getSession(from);
  const path = Array.isArray(ses.selectedLocationPath) ? ses.selectedLocationPath : [];
  const parentId = path.length ? path[path.length - 1].id : null;

  // 讀取目前層的選項
  let parts = await getChildrenSafe(parentId);

  // ─────────────────────────────────────────────────────────
  // 解析輸入
  const raw = (msg || '').trim();
  const isNum = /^\d+$/.test(raw);
  const n = isNum ? parseInt(raw, 10) : NaN;

  // z 或 /restart = 重置回 root
  if (/^z$/i.test(raw) || raw === '/restart') {
    await setSession(from, {
      selectedLocationPath: admin.firestore.FieldValue.delete(),
      finalLocation: admin.firestore.FieldValue.delete()
    });
    const root = await getChildrenSafe(null);
    if (!root.length) {
      return { text: '⚠️ 系統未找到任何身體部位資料，請稍後再試或聯絡管理員。' };
    }
    return {
      text: `📍 請選擇你不適的身體部位：\n\n${fmt(root, false)}\n\n請輸入數字，例如：1`
    };
  }

  // 0 = 返回上一層（只在非 root 有效）
  if (isNum && n === 0 && path.length > 0) {
    const newPath = path.slice(0, -1);
    await setSession(from, { selectedLocationPath: newPath });
    const pid = newPath.length ? newPath[newPath.length - 1].id : null;
    const siblings = await getChildrenSafe(pid);
    return {
      text: `↩️ 已返回上一層。\n請選擇：\n\n${fmt(siblings, newPath.length > 0)}\n\n請輸入數字，例如：1`
    };
  }

  // 合法選擇 1..N
  if (isNum && n >= 1 && n <= parts.length) {
    const selected = parts[n - 1];
    const newPath = [...path, selected];
    const kids = await getChildrenSafe(selected.id);

    if (kids.length > 0) {
      // 還有下一層 → 繼續
      await setSession(from, { selectedLocationPath: newPath });
      return {
        text: `📍 你選擇的是：${selected.name_zh || selected.name || selected.id}\n` +
              `請選擇更細的部位：\n\n${fmt(kids, true)}\n\n請輸入數字，例如：1`
      };
    }

    // 最底層 → 完成 location
    await setSession(from, {
      selectedLocationPath: newPath,
      finalLocation: selected
    });
    return {
      text: `✅ 你選擇的是：${selected.name_zh || selected.name || selected.id}，我們會繼續問診。`,
      done: true,
      finalLocation: selected
    };
  }

  // 非數字或超範圍
  // 若「無子項且非 root」→ 自動退一層避免卡只剩 0
  if (!isNum && parts.length === 0 && path.length > 0) {
    const newPath = path.slice(0, -1);
    await setSession(from, { selectedLocationPath: newPath });
    const pid = newPath.length ? newPath[newPath.length - 1].id : null;
    const siblings = await getChildrenSafe(pid);
    return {
      text: `（已自動返回上一層）\n請選擇：\n\n${fmt(siblings, newPath.length > 0)}\n\n請輸入數字，例如：1`
    };
  }

  // Root 層沒有資料 → 明確提示
  if (parts.length === 0 && path.length === 0) {
    return { text: '⚠️ 系統未找到任何身體部位資料，請稍後再試或聯絡管理員。' };
  }

  // 顯示目前層
  return {
    text: `📍 請選擇你不適的身體部位：\n\n${fmt(parts, path.length > 0)}\n\n請輸入數字，例如：1`
  };
}

module.exports = { handleLocation };