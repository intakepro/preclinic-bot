// modules/interview/symptom_selector.js
// Version: v2.0.0 (multi-select)
// 功能：症狀多選（跨頁保留），完成後回傳 done:true 並寫入 selectedSymptoms（陣列）與 selectedSymptom（第一項，向後相容）
//
// 資料來源優先序：
//   1) symptoms_by_location/{location_id}.symptoms  （建議使用；免索引）
//   2) symptoms_by_location（flat 每症狀一筆）：where('location_id','==',X).orderBy('sort_order')（有索引更佳）
//   3) body_parts_tree/{location_id}.related_symptom_ids → 再至 symptoms 主表補中文名
//
// Firestore 建議索引（僅當你用 flat 結構時需要）：
//   collection: symptoms_by_location
//   fields: location_id ASC, sort_order ASC

const admin = require('firebase-admin');
const db = admin.firestore();

const SESSIONS           = 'sessions';
const SYMPTOMS_COLL      = 'symptoms_by_location';
const BODY_PARTS_COLL    = 'body_parts_tree';
const SYMPTOMS_MASTER    = 'symptoms';

const PAGE_SIZE = parseInt(process.env.SYMPTOM_PAGE_SIZE || '8', 10);
const keyOf = (from) => (from || '').toString().replace(/^whatsapp:/i, '').trim();

async function getSession(from) {
  const snap = await db.collection(SESSIONS).doc(keyOf(from)).get();
  return snap.exists ? (snap.data() || {}) : {};
}
async function setSession(from, patch) {
  await db.collection(SESSIONS).doc(keyOf(from)).set(
    { ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

// ── 資料來源 1：每部位一筆（doc 內含 symptoms 陣列）
async function fetchByDocArray(locationId) {
  const doc = await db.collection(SYMPTOMS_COLL).doc(locationId).get();
  if (!doc.exists) return [];
  const data = doc.data() || {};
  const arr = Array.isArray(data.symptoms) ? data.symptoms.slice() : [];
  arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  return arr.map(x => ({ id: x.id, name_zh: x.name_zh || x.name || x.id, sort_order: x.sort_order ?? 0 }));
}

// ── 資料來源 2：flat（需要索引；提供 fallback）
async function fetchByFlatCollection(locationId) {
  const col = db.collection(SYMPTOMS_COLL);
  try {
    const snap = await col.where('location_id', '==', locationId).orderBy('sort_order').get();
    return snap.docs.map(d => {
      const v = d.data() || {};
      return { id: d.id, name_zh: v.name_zh || v.name || v.symptom_zh || d.id, sort_order: v.sort_order ?? 0 };
    });
  } catch (e) {
    const msg = String(e?.message || '');
    if (e.code === 9 || msg.includes('FAILED_PRECONDITION') || msg.includes('requires an index')) {
      // 索引未建 → 降級：不排序查詢 + 記憶體排序
      const snap = await col.where('location_id', '==', locationId).get();
      const rows = snap.docs.map(d => {
        const v = d.data() || {};
        return { id: d.id, name_zh: v.name_zh || v.name || v.symptom_zh || d.id, sort_order: v.sort_order ?? 0 };
      });
      rows.sort((a, b) => a.sort_order - b.sort_order);
      return rows;
    }
    throw e;
  }
}

// ── 資料來源 3：由 body_parts_tree 的 related_symptom_ids + symptoms 主表補名
async function fetchFromBodyPartsMapping(locationId) {
  const bp = await db.collection(BODY_PARTS_COLL).doc(locationId).get();
  if (!bp.exists) return [];
  const ids = Array.isArray((bp.data() || {}).related_symptom_ids) ? (bp.data().related_symptom_ids).filter(Boolean) : [];
  if (ids.length === 0) return [];

  const chunks = [];
  for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));

  const nameMap = new Map();
  for (const ch of chunks) {
    const snap = await db.collection(SYMPTOMS_MASTER)
      .where(admin.firestore.FieldPath.documentId(), 'in', ch).get();
    for (const d of snap.docs) {
      const v = d.data() || {};
      nameMap.set(d.id, v.name_zh || v.name || d.id);
    }
  }

  return ids.map((id, i) => ({ id, name_zh: nameMap.get(id) || id, sort_order: i + 1 }));
}

async function fetchSymptomsByLocation(locationId) {
  // 1) Doc 陣列（最穩定）
  const a = await fetchByDocArray(locationId);
  if (a.length) return a;

  // 2) Flat
  const b = await fetchByFlatCollection(locationId);
  if (b.length) return b;

  // 3) Fallback by mapping
  const c = await fetchFromBodyPartsMapping(locationId);
  return c;
}

function pageSlice(items, page, pageSize = PAGE_SIZE) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safe = Math.min(Math.max(1, page), pages);
  const start = (safe - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  return { list: items.slice(start, end), page: safe, pages, total };
}

function idxMap(listLength, hasPrev, hasNext) {
  // 回傳各個控制項的編號
  // 1..listLength → 勾選/取消
  // 之後依序：◀️ 上一頁、▶️ 下一頁、🧹 清除、✅ 完成、0 返回
  let base = listLength;
  const idxPrev  = hasPrev ? ++base : null;
  const idxNext  = hasNext ? ++base : null;
  const idxClear = ++base;
  const idxDone  = ++base;
  return { idxPrev, idxNext, idxClear, idxDone };
}

function fmtList(list, selectedIdsSet, hasPrev, hasNext) {
  const lines = list.map((s, i) => {
    const mark = selectedIdsSet.has(s.id) ? '☑️' : '⬜️';
    return `${i + 1}. ${mark} ${s.name_zh || s.name || s.id}`;
  });
  const { idxPrev, idxNext, idxClear, idxDone } = idxMap(list.length, hasPrev, hasNext);
  if (idxPrev)  lines.push(`${idxPrev}. ◀️ 上一頁`);
  if (idxNext)  lines.push(`${idxNext}. ▶️ 下一頁`);
  lines.push(`${idxClear}. 🧹 清除已選`);
  lines.push(`${idxDone}. ✅ 完成送出`);
  lines.push(`0. ↩️ 返回部位選擇`);
  return lines.join('\n');
}

function uniqById(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!x || !x.id || seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x);
  }
  return out;
}

async function handleSymptomSelector({ from, msg }) {
  const ses = await getSession(from);

  // 取得最終部位；若無，導回 location
  const finalLoc = ses.finalLocation || (Array.isArray(ses.selectedLocationPath) ? ses.selectedLocationPath[ses.selectedLocationPath.length - 1] : null);
  if (!finalLoc || !finalLoc.id) {
    await setSession(from, { interview_step: 'location' });
    return { text: '⚠️ 未找到已選部位，已返回部位選擇。', done: false };
  }

  // 取得該部位症狀清單
  const all = await fetchSymptomsByLocation(finalLoc.id);

  // 若完全沒有預置清單 → 允許直接輸入多個症狀（以逗號/頓號/分號/換行分隔）
  if (!all || all.length === 0) {
    const raw = (msg || '').trim();
    if (raw) {
      const parts = raw.split(/[,，;；\n]+/).map(s => s.trim()).filter(Boolean);
      if (parts.length) {
        const items = parts.map((t, i) => ({ id: t.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,''), name_zh: t, sort_order: i + 1 }));
        await setSession(from, { selectedSymptoms: items, selectedSymptom: items[0] || null, symptomSelectorPage: 1 });
        return { text: `✅ 已記錄症狀：${parts.join('、')}`, done: true, selectedSymptom: items[0] || null };
      }
    }
    return { text: `📝 這個部位（${finalLoc.name_zh || finalLoc.id}）暫未有預設症狀清單。\n請直接輸入你的症狀，可一次輸入多個，以逗號分隔。`, done: false };
  }

  // 從 session 取已選
  const selected = Array.isArray(ses.selectedSymptoms) ? ses.selectedSymptoms.slice() : [];
  const selectedIds = new Set(selected.map(x => x.id));

  // 分頁
  const page = Number.isInteger(ses.symptomSelectorPage) ? ses.symptomSelectorPage : 1;
  const { list, page: cur, pages } = pageSlice(all, page);
  const hasPrev = cur > 1;
  const hasNext = cur < pages;
  const { idxPrev, idxNext, idxClear, idxDone } = idxMap(list.length, hasPrev, hasNext);

  // 解析輸入
  const raw = (msg || '').trim();
  const isNum = /^\d+$/.test(raw);
  const n = isNum ? parseInt(raw, 10) : NaN;

  // 0 = 返回部位選擇（並清空已選）
  if (isNum && n === 0) {
    await setSession(from, {
      interview_step: 'location',
      selectedSymptom: admin.firestore.FieldValue.delete(),
      selectedSymptoms: admin.firestore.FieldValue.delete(),
      symptomSelectorPage: 1
    });
    return { text: '↩️ 已返回部位選擇。', done: false };
  }

  // ◀️ 上一頁
  if (isNum && idxPrev && n === idxPrev) {
    const prev = cur - 1;
    await setSession(from, { symptomSelectorPage: prev });
    const prevSlice = pageSlice(all, prev);
    return {
      text: `📋 請選擇症狀（${prevSlice.page}/${prevSlice.pages}）：\n\n` +
            `${fmtList(prevSlice.list, selectedIds, prevSlice.page > 1, prevSlice.page < prevSlice.pages)}\n\n` +
            `👉 請輸入數字：1..${prevSlice.list.length} 勾選/取消；或選「✅ 完成」送出。`,
      done: false
    };
  }

  // ▶️ 下一頁
  if (isNum && idxNext && n === idxNext) {
    const next = cur + 1;
    await setSession(from, { symptomSelectorPage: next });
    const nextSlice = pageSlice(all, next);
    return {
      text: `📋 請選擇症狀（${nextSlice.page}/${nextSlice.pages}）：\n\n` +
            `${fmtList(nextSlice.list, selectedIds, nextSlice.page > 1, nextSlice.page < nextSlice.pages)}\n\n` +
            `👉 請輸入數字：1..${nextSlice.list.length} 勾選/取消；或選「✅ 完成」送出。`,
      done: false
    };
  }

  // 🧹 清除已選
  if (isNum && n === idxClear) {
    await setSession(from, { selectedSymptoms: [], selectedSymptom: admin.firestore.FieldValue.delete() });
    const freshSet = new Set();
    return {
      text: `🧹 已清除已選。\n\n📋 請選擇症狀（${cur}/${pages}）：\n\n` +
            `${fmtList(list, freshSet, hasPrev, hasNext)}\n\n` +
            `👉 請輸入數字：1..${list.length} 勾選/取消；或選「✅ 完成」送出。`,
      done: false
    };
  }

  // ✅ 完成送出（需至少選 1 項）
  if (isNum && n === idxDone) {
    if (selected.length === 0) {
      return { text: '⚠️ 請先至少勾選一項，再選「✅ 完成」。', done: false };
    }
    const unique = uniqById(selected);
    await setSession(from, {
      selectedSymptoms: unique,
      selectedSymptom: unique[0] || null, // 供舊流程相容
      symptomSelectorPage: 1
    });
    const names = unique.map(x => x.name_zh || x.id).join('、');
    return { text: `✅ 你選擇的症狀：${names}`, done: true, selectedSymptom: unique[0] || null };
  }

  // 1..N 勾選/取消
  if (isNum && n >= 1 && n <= list.length) {
    const item = list[n - 1];
    if (selectedIds.has(item.id)) {
      // 取消
      const newSel = selected.filter(x => x.id !== item.id);
      await setSession(from, { selectedSymptoms: newSel, selectedSymptom: newSel[0] || admin.firestore.FieldValue.delete() });
      const newSet = new Set(newSel.map(x => x.id));
      return {
        text: `☑️ 已取消：${item.name_zh}\n\n📋 請繼續選擇（${cur}/${pages}）：\n\n` +
              `${fmtList(list, newSet, hasPrev, hasNext)}\n\n` +
              `👉 可多選；選「✅ 完成」送出。`,
        done: false
      };
    } else {
      // 勾選
      const newSel = uniqById([...selected, { id: item.id, name_zh: item.name_zh, sort_order: item.sort_order }]);
      await setSession(from, { selectedSymptoms: newSel, selectedSymptom: newSel[0] || null });
      const newSet = new Set(newSel.map(x => x.id));
      return {
        text: `☑️ 已選：${item.name_zh}\n\n📋 請繼續選擇（${cur}/${pages}）：\n\n` +
              `${fmtList(list, newSet, hasPrev, hasNext)}\n\n` +
              `👉 可多選；選「✅ 完成」送出。`,
        done: false
      };
    }
  }

  // 非數字或超範圍 → 顯示當頁
  await setSession(from, { symptomSelectorPage: cur });
  return {
    text: `📋 請選擇症狀（${cur}/${pages}）：\n\n` +
          `${fmtList(list, selectedIds, hasPrev, hasNext)}\n\n` +
          `👉 請輸入數字：1..${list.length} 勾選/取消；或選「✅ 完成」送出。`,
    done: false
  };
}

module.exports = { handleSymptomSelector };