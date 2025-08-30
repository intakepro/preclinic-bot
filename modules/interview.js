// modules/interview/symptom_selector.js
// Version: v2.1.1 (multi-select + batch input; fixed stage key & location fallbacks)

const admin = require('firebase-admin');
const db = admin.firestore();

const SESSIONS        = 'sessions';
const SYMPTOMS_COLL   = 'symptoms_by_location';
const BODY_PARTS_COLL = 'body_parts_tree';
const SYMPTOMS_MASTER = 'symptoms';

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

// -------- helpers: get chosen location (兼容不同欄位名稱) --------
function getChosenLocation(s) {
  if (s?.finalLocation?.id) return s.finalLocation;
  const path = Array.isArray(s?.selectedLocationPath) ? s.selectedLocationPath : [];
  if (path.length && path[path.length - 1]?.id) return path[path.length - 1];
  if (s?.selectedLocation?.id) return s.selectedLocation;
  // 其他可能舊欄位
  if (s?.location?.current?.id) return s.location.current;
  if (s?.location?.selected?.id) return s.location.selected;
  return null;
}

// -------- 資料來源 1：doc 內含 symptoms 陣列 --------
async function fetchByDocArray(locationId) {
  const doc = await db.collection(SYMPTOMS_COLL).doc(locationId).get();
  if (!doc.exists) return [];
  const data = doc.data() || {};
  const arr = Array.isArray(data.symptoms) ? data.symptoms.slice() : [];
  arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  return arr.map(x => ({ id: x.id, name_zh: x.name_zh || x.name || x.id, sort_order: x.sort_order ?? 0 }));
}

// -------- 資料來源 2：flat（有索引更佳；有 fallback） --------
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

// -------- 資料來源 3：body_parts_tree.related_symptom_ids + 主表補名 --------
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
  const a = await fetchByDocArray(locationId);
  if (a.length) return a;
  const b = await fetchByFlatCollection(locationId);
  if (b.length) return b;
  return await fetchFromBodyPartsMapping(locationId);
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
// 支援 , ， ; ； 、 空格
function parseMultiNumbers(raw) {
  const parts = (raw || '')
    .split(/[,，;；、\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => parseInt(s, 10))
    .filter(n => Number.isInteger(n));
  return Array.from(new Set(parts));
}

// ---------------- main ----------------
async function handleSymptomSelector({ from, msg }) {
  const ses = await getSession(from);

  // ① 取得所選部位（多重兼容）
  const finalLoc = getChosenLocation(ses);
  if (!finalLoc || !finalLoc.id) {
    await setSession(from, { interview_stage: 'location' }); // ✅ 正確 key
    return { text: '⚠️ 未找到已選部位，已返回部位選擇。', done: false };
  }

  // ② 讀該部位症狀清單
  const all = await fetchSymptomsByLocation(finalLoc.id);

  // 無清單 → 允許直接輸入多個症狀文字
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

  // ③ 已選集合 & 分頁
  const selected = Array.isArray(ses.selectedSymptoms) ? ses.selectedSymptoms.slice() : [];
  const selectedIds = new Set(selected.map(x => x.id));

  const page = Number.isInteger(ses.symptomSelectorPage) ? ses.symptomSelectorPage : 1;
  const { list, page: cur, pages } = pageSlice(all, page);
  const hasPrev = cur > 1;
  const hasNext = cur < pages;
  const { idxPrev, idxNext, idxClear, idxDone } = idxMap(list.length, hasPrev, hasNext);

  // ④ 解析輸入
  const raw = (msg || '').trim();
  const nums = parseMultiNumbers(raw);
  const singleNum = (nums.length === 1) ? nums[0] : null;

  // 0=返回部位
  if (singleNum === 0) {
    await setSession(from, {
      interview_stage: 'location', // ✅ 正確 key
      selectedSymptom: admin.firestore.FieldValue.delete(),
      selectedSymptoms: admin.firestore.FieldValue.delete(),
      symptomSelectorPage: 1
    });
    return { text: '↩️ 已返回部位選擇。', done: false };
  }

  // ◀️/▶️/清除/完成（單一數字時）
  if (nums.length === 1) {
    const n = singleNum;

    if (idxPrev && n === idxPrev) {
      const prev = cur - 1;
      await setSession(from, { symptomSelectorPage: prev });
      const s2 = pageSlice(all, prev);
      return {
        text: `📋 請選擇症狀（${s2.page}/${s2.pages}）：\n\n${fmtList(s2.list, selectedIds, s2.page > 1, s2.page < s2.pages)}\n\n👉 可多選：輸入 1..${s2.list.length}，或「1,3,5」批次勾選；選「✅ 完成」送出。`,
        done: false
      };
    }
    if (idxNext && n === idxNext) {
      const next = cur + 1;
      await setSession(from, { symptomSelectorPage: next });
      const s2 = pageSlice(all, next);
      return {
        text: `📋 請選擇症狀（${s2.page}/${s2.pages}）：\n\n${fmtList(s2.list, selectedIds, s2.page > 1, s2.page < s2.pages)}\n\n👉 可多選：輸入 1..${s2.list.length}，或「1,3,5」批次勾選；選「✅ 完成」送出。`,
        done: false
      };
    }
    if (n === idxClear) {
      await setSession(from, { selectedSymptoms: [], selectedSymptom: admin.firestore.FieldValue.delete() });
      const fresh = new Set();
      return {
        text: `🧹 已清除已選。\n\n📋 請繼續選擇（${cur}/${pages}）：\n\n${fmtList(list, fresh, hasPrev, hasNext)}\n\n👉 可多選：輸入 1..${list.length}，或「1,3,5」批次勾選；選「✅ 完成」送出。`,
        done: false
      };
    }
    if (n === idxDone) {
      if (selected.length === 0) return { text: '⚠️ 請先至少勾選一項，再選「✅ 完成」。', done: false };
      const unique = uniqById(selected);
      await setSession(from, { selectedSymptoms: unique, selectedSymptom: unique[0] || null, symptomSelectorPage: 1 });
      const names = unique.map(x => x.name_zh || x.id).join('、');
      return { text: `✅ 你選擇的症狀：${names}`, done: true, selectedSymptom: unique[0] || null };
    }
  }

  // 批次勾選/取消
  const toggleIdx = nums.filter(n => n >= 1 && n <= list.length);
  if (toggleIdx.length > 0) {
    const selSet = new Set(selected.map(x => x.id));
    let newSel = selected.slice();

    for (const n of toggleIdx) {
      const item = list[n - 1];
      if (!item) continue;
      if (selSet.has(item.id)) {
        newSel = newSel.filter(x => x.id !== item.id);
        selSet.delete(item.id);
      } else {
        newSel.push({ id: item.id, name_zh: item.name_zh, sort_order: item.sort_order });
        selSet.add(item.id);
      }
    }
    newSel = uniqById(newSel);
    await setSession(from, { selectedSymptoms: newSel, selectedSymptom: newSel[0] || null });

    const newSet = new Set(newSel.map(x => x.id));
    return {
      text: `☑️ 已更新選擇（本頁）：${toggleIdx.join('、')}\n\n📋 請繼續選擇（${cur}/${pages}）：\n\n${fmtList(list, newSet, hasPrev, hasNext)}\n\n👉 可多選：輸入 1..${list.length}，或「1,3,5」批次勾選；選「✅ 完成」送出。`,
      done: false
    };
  }

  // 無效輸入 → 顯示當頁
  await setSession(from, { symptomSelectorPage: cur });
  return {
    text: `📋 請選擇症狀（${cur}/${pages}）：\n\n${fmtList(list, selectedIds, hasPrev, hasNext)}\n\n👉 可多選：輸入 1..${list.length}，或「1,3,5」批次勾選；選「✅ 完成」送出。`,
    done: false
  };
}

module.exports = { handleSymptomSelector };