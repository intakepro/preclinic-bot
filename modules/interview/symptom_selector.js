// modules/interview/symptom_selector.js
// Version: v1.1.0
// 變更：加入「◀️ 上一頁 / ▶️ 下一頁」控制；保留 0=返回部位選擇

const admin = require('firebase-admin');
const db = admin.firestore();

const SESSIONS = 'sessions';
const SYMPTOMS_COLL = 'symptoms_by_location';

const PAGE_SIZE = parseInt(process.env.SYMPTOM_PAGE_SIZE || '8', 10);

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

// 取得某部位的症狀（同時支援兩種資料結構；內建索引 fallback）
async function fetchSymptomsByLocation(locationId) {
  const col = db.collection(SYMPTOMS_COLL);

  // 方案 a：每個症狀一筆文件（where + orderBy）
  try {
    let q = col.where('location_id', '==', locationId).orderBy('sort_order');
    const snap = await q.get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (rows.length > 0) return rows;
  } catch (e) {
    const msg = String(e && e.message || '');
    if (e.code === 9 || msg.includes('FAILED_PRECONDITION') || msg.includes('requires an index')) {
      // 索引未建：降級為不排序查詢 + 內存排序
      const q = col.where('location_id', '==', locationId);
      const snap = await q.get();
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      rows.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      if (rows.length > 0) return rows;
    } else {
      throw e;
    }
  }

  // 方案 b：每個部位一筆文件，內含 symptoms 陣列
  const doc = await col.doc(locationId).get();
  if (doc.exists) {
    const data = doc.data() || {};
    const rows = Array.isArray(data.symptoms) ? data.symptoms.slice() : [];
    rows.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    return rows;
  }

  return [];
}

function pageSlice(items, page, pageSize = PAGE_SIZE) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pages);
  const start = (safePage - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  return {
    list: items.slice(start, end),
    page: safePage,
    pages,
    total
  };
}

// 計算上一頁/下一頁的數字索引位置
function navIndices(listLength, hasPrev, hasNext) {
  let idxPrev = null;
  let idxNext = null;
  let base = listLength;
  if (hasPrev) { idxPrev = base + 1; base += 1; }
  if (hasNext) { idxNext = base + 1; }
  return { idxPrev, idxNext };
}

function formatOptions(list, hasPrev, hasNext) {
  const lines = list.map((s, i) => `${i + 1}. ${s.name_zh || s.name || s.id}`);
  const { idxPrev, idxNext } = navIndices(list.length, hasPrev, hasNext);
  if (idxPrev) lines.push(`${idxPrev}. ◀️ 上一頁`);
  if (idxNext) lines.push(`${idxNext}. ▶️ 下一頁`);
  lines.push(`0. ↩️ 返回部位選擇`);
  return lines.join('\n');
}

async function handleSymptomSelector({ from, msg }) {
  const ses = await getSession(from);

  // 取得最終部位；若無，導回 location
  const finalLoc = ses.finalLocation || (Array.isArray(ses.selectedLocationPath) ? ses.selectedLocationPath[ses.selectedLocationPath.length - 1] : null);
  if (!finalLoc || !finalLoc.id) {
    await setSession(from, { interview_step: 'location' });
    return { text: '⚠️ 未找到已選部位，已返回部位選擇。', done: false };
  }

  const all = await fetchSymptomsByLocation(finalLoc.id);

  // 無預設清單 → 允許自由輸入
  if (!all || all.length === 0) {
    const raw = (msg || '').trim();
    if (raw && !/^\d+$/.test(raw)) {
      const custom = { id: 'custom', name_zh: raw, custom: true, location_id: finalLoc.id };
      await setSession(from, { selectedSymptom: custom });
      return { text: `✅ 已記錄症狀：「${raw}」`, done: true, selectedSymptom: custom };
    }
    return {
      text: [
        `📝 這個部位（${finalLoc.name_zh || finalLoc.id}）暫未有預設症狀清單。`,
        '請直接輸入你的症狀描述（例如：刺痛、灼熱、腫脹⋯⋯）',
      ].join('\n'),
      done: false
    };
  }

  const currentPage = Number.isInteger(ses.symptomSelectorPage) ? ses.symptomSelectorPage : 1;
  const { list, page, pages } = pageSlice(all, currentPage);

  const raw = (msg || '').trim();
  const isNum = /^\d+$/.test(raw);
  const n = isNum ? parseInt(raw, 10) : NaN;

  const hasPrev = page > 1;
  const hasNext = page < pages;
  const { idxPrev, idxNext } = navIndices(list.length, hasPrev, hasNext);

  // 0 = 返回部位選擇
  if (isNum && n === 0) {
    await setSession(from, { interview_step: 'location', symptomSelectorPage: 1, selectedSymptom: admin.firestore.FieldValue.delete() });
    return { text: '↩️ 已返回部位選擇。', done: false };
  }

  // ◀️ 上一頁
  if (isNum && idxPrev && n === idxPrev) {
    const prevPage = page - 1;
    await setSession(from, { symptomSelectorPage: prevPage });
    const prev = pageSlice(all, prevPage);
    return {
      text: `📋 請選擇症狀（${prev.page}/${prev.pages}）：\n\n` +
            `${formatOptions(prev.list, prev.page > 1, prev.page < prev.pages)}\n\n` +
            `請輸入數字選項，例如：1`,
      done: false
    };
  }

  // ▶️ 下一頁
  if (isNum && idxNext && n === idxNext) {
    const nextPage = page + 1;
    await setSession(from, { symptomSelectorPage: nextPage });
    const next = pageSlice(all, nextPage);
    return {
      text: `📋 請選擇症狀（${next.page}/${next.pages}）：\n\n` +
            `${formatOptions(next.list, next.page > 1, next.page < next.pages)}\n\n` +
            `請輸入數字選項，例如：1`,
      done: false
    };
  }

  // 選擇當頁症狀
  if (isNum && n >= 1 && n <= list.length) {
    const chosen = list[n - 1];
    await setSession(from, { selectedSymptom: chosen, symptomSelectorPage: 1 });
    return { text: `✅ 你選擇的症狀：${chosen.name_zh || chosen.name || chosen.id}`, done: true, selectedSymptom: chosen };
  }

  // 顯示當頁
  await setSession(from, { symptomSelectorPage: page });
  return {
    text: `📋 請選擇症狀（${page}/${pages}）：\n\n` +
          `${formatOptions(list, hasPrev, hasNext)}\n\n` +
          `請輸入數字選項，例如：1`,
    done: false
  };
}

module.exports = { handleSymptomSelector };