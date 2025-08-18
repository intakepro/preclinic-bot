// modules/history.js
// Version: 6.3
// 介面：async handleHistory({ from, msg, patientId, patientName }) -> { message: string, done?: boolean }
//
// 重點：
// - 線性流程（簡單、直覺）
// - 頂部顯示「病人：{name}（{phone末四碼}）」
// - 只有在「選 2 下一步」或「總結確認選 2」時回傳 done:true，其餘皆由模組內部互動
// - Firestore 結構：users/{fromPhone}/patients/{patientId} 下的 history 欄位
//
// 需要 index 在 sessions/{from} 中寫入 selectedPatient = { patientId, name, phone }（由 name_input 模組完成）
// index 呼叫本模組時會傳 { from, msg, patientId, patientName }（若 patientId 缺失則從 sessions 讀）

'use strict';

const admin = require('firebase-admin');

// ---------- Firebase 初始化 ----------
(function ensureFirebase() {
  if (admin.apps.length) return;
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      console.log('[history] Firebase via FIREBASE_SERVICE_ACCOUNT');
    } else {
      admin.initializeApp();
      console.log('[history] Firebase via default credentials');
    }
  } catch (e) {
    console.error('[history] Firebase init error:', e?.message || e);
    throw e;
  }
})();
const db = admin.firestore();

// ---------- 小工具 ----------
const phoneOf = (from) =>
  (from || '').toString().replace(/^whatsapp:/i, '').trim();

const last4 = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d.slice(-4).padStart(4, '*');
};

const banner = (name, phone) => `👤 病人：${name || '（未命名）'}（${last4(phone)}）`;

const arrFromText = (text) =>
  String(text || '')
    .split(/[,，、\n]/)
    .map(s => s.trim())
    .filter(Boolean);

const fmtList = (arr) =>
  Array.isArray(arr) && arr.length
    ? arr.map(v => `  • ${v}`).join('\n')
    : '  （無）';

const fmtText = (s) => (s && String(s).trim() ? String(s).trim() : '（無）');

const renderSummary = (h = {}) => {
  const pmh   = fmtList(h.pmh || []);
  const meds  = fmtList(h.meds || []);
  const types = fmtList((h.allergies && h.allergies.types) || []);
  const items = fmtList((h.allergies && h.allergies.items) || []);
  const smk   = fmtText(h.social?.smoking);
  const alc   = fmtText(h.social?.alcohol);
  const trv   = fmtText(h.social?.travel);
  return [
    '📋 病史摘要：',
    '',
    '— 過去病史（PMH）—',
    pmh,
    '',
    '— 現用藥（Meds）—',
    meds,
    '',
    '— 過敏（Allergies）—',
    `  類型：\n${types}`,
    `  明細：\n${items}`,
    '',
    '— 社會史（Social）—',
    `  吸菸：${smk}`,
    `  飲酒：${alc}`,
    `  旅遊：${trv}`,
  ].join('\n');
};

// ---------- Firestore I/O ----------
async function readIndexSession(from) {
  const key = phoneOf(from) || 'DEFAULT';
  const ref = db.collection('sessions').doc(key);
  const s = await ref.get();
  return s.exists ? s.data() : {};
}

function paths(fromPhone, patientId) {
  const userRef = db.collection('users').doc(fromPhone);
  const patientRef = userRef.collection('patients').doc(patientId);
  const sessionRef = db.collection('sessions').doc(fromPhone);
  return { userRef, patientRef, sessionRef };
}

async function readPatient(fromPhone, patientId) {
  const { patientRef } = paths(fromPhone, patientId);
  const snap = await patientRef.get();
  return snap.exists ? { id: patientId, ...snap.data() } : null;
}

async function writeHistory(fromPhone, patientId, history) {
  const { patientRef } = paths(fromPhone, patientId);
  await patientRef.set(
    { history, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

async function readHistSession(fromPhone) {
  const ref = db.collection('history_sessions').doc(fromPhone);
  const s = await ref.get();
  return s.exists ? s.data() : { state: 'ENTRY', buf: {} };
}
async function writeHistSession(fromPhone, patch) {
  const ref = db.collection('history_sessions').doc(fromPhone);
  await ref.set(
    { ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

// ---------- 主處理器（線性流程） ----------
/**
 * 狀態：
 * ENTRY
 * SHOW_EXISTING          -> 等 1/2
 * PMH_INPUT              -> 文字
 * MEDS_INPUT             -> 文字
 * ALG_TYPES_INPUT        -> 文字
 * ALG_ITEMS_INPUT        -> 文字
 * SOCIAL_SMOKING_INPUT   -> 文字
 * SOCIAL_ALCOHOL_INPUT   -> 文字
 * SOCIAL_TRAVEL_INPUT    -> 文字
 * REVIEW                 -> 等 1/2（1 重新填，2 下一步）
 */
async function handleHistory({ from, msg, patientId, patientName }) {
  const fromPhone = phoneOf(from);
  const body = (msg || '').trim();

  // 取得 selectedPatient（若呼叫未帶 patientId，則從 sessions 讀）
  if (!patientId || !patientName) {
    const s = await readIndexSession(from);
    const sel = s.selectedPatient || {};
    patientId = patientId || sel.patientId;
    patientName = patientName || sel.name;
  }
  if (!fromPhone || !patientId) {
    return {
      message:
        '⚠️ 尚未選定病人，請先完成第 1 步（選擇或新增病人）。\n' +
        '（可輸入「我想做預先問診」或 restart 回到歡迎畫面）'
    };
  }

  const sess = await readHistSession(fromPhone);
  let state = sess.state || 'ENTRY';
  let buf = sess.buf || {};

  // 取患者資料
  const patientDoc = await readPatient(fromPhone, patientId);
  const patientPhone = patientDoc?.phone || fromPhone;
  const nameForBanner = patientDoc?.name || patientName;

  // 入口：判斷是否已有病史
  if (state === 'ENTRY') {
    const hasHistory = !!(patientDoc && patientDoc.history &&
      (
        (Array.isArray(patientDoc.history.pmh) && patientDoc.history.pmh.length) ||
        (Array.isArray(patientDoc.history.meds) && patientDoc.history.meds.length) ||
        (patientDoc.history.allergies &&
          ((Array.isArray(patientDoc.history.allergies.types) && patientDoc.history.allergies.types.length) ||
           (Array.isArray(patientDoc.history.allergies.items) && patientDoc.history.allergies.items.length))) ||
        (patientDoc.history.social &&
          (patientDoc.history.social.smoking ||
           patientDoc.history.social.alcohol ||
           patientDoc.history.social.travel))
      )
    );

    if (hasHistory) {
      await writeHistSession(fromPhone, { state: 'SHOW_EXISTING', buf: {} });
      return {
        message:
`${banner(nameForBanner, patientPhone)}

${renderSummary(patientDoc.history)}

是否需要更改？
1️⃣ 需要更改
2️⃣ 下一步`
      };
    } else {
      await writeHistSession(fromPhone, { state: 'PMH_INPUT', buf: {} });
      return {
        message:
`${banner(nameForBanner, patientPhone)}

尚未建立病史，先從「過去病史（PMH）」開始。
請輸入過去病史，多項以「，」、「、」或換行分隔。
（例如：高血壓、糖尿病、痛風）`
      };
    }
  }

  // 已有病史 → 決策
  if (state === 'SHOW_EXISTING') {
    if (body === '1') {
      await writeHistSession(fromPhone, { state: 'PMH_INPUT', buf: {} });
      return {
        message:
`${banner(nameForBanner, patientPhone)}

請輸入過去病史（PMH），多項以「，」、「、」或換行分隔。`
      };
    }
    if (body === '2') {
      await writeHistSession(fromPhone, { state: 'ENTRY', buf: {} });
      return { message: '✅ 病史已確認無需更改，進入下一步。', done: true };
    }
    return { message: '請輸入 1（需要更改）或 2（下一步）。' };
  }

  // PMH
  if (state === 'PMH_INPUT') {
    const pmh = arrFromText(body);
    buf.history = buf.history || {};
    buf.history.pmh = pmh;
    await writeHistSession(fromPhone, { state: 'MEDS_INPUT', buf });
    return {
      message:
`${banner(nameForBanner, patientPhone)}

✅ 已記錄 PMH
${fmtList(pmh)}

請輸入「現用藥（Meds）」清單，多項以「，」、「、」或換行分隔。
（例如：二甲雙胍、阿司匹林）`
    };
  }

  // Meds
  if (state === 'MEDS_INPUT') {
    const meds = arrFromText(body);
    buf.history = buf.history || {};
    buf.history.meds = meds;
    await writeHistSession(fromPhone, { state: 'ALG_TYPES_INPUT', buf });
    return {
      message:
`${banner(nameForBanner, patientPhone)}

✅ 已記錄現用藥
${fmtList(meds)}

請輸入「過敏類型（types）」清單（例如：藥物、食物、環境）。`
    };
  }

  // 過敏類型
  if (state === 'ALG_TYPES_INPUT') {
    const types = arrFromText(body);
    buf.history = buf.history || {};
    buf.history.allergies = buf.history.allergies || {};
    buf.history.allergies.types = types;
    await writeHistSession(fromPhone, { state: 'ALG_ITEMS_INPUT', buf });
    return {
      message:
`${banner(nameForBanner, patientPhone)}

✅ 已記錄過敏類型
${fmtList(types)}

請輸入「過敏明細（items）」清單（例如：阿莫西林、花生、塵蟎）。`
    };
  }

  // 過敏明細
  if (state === 'ALG_ITEMS_INPUT') {
    const items = arrFromText(body);
    buf.history = buf.history || {};
    buf.history.allergies = buf.history.allergies || {};
    buf.history.allergies.items = items;
    await writeHistSession(fromPhone, { state: 'SOCIAL_SMOKING_INPUT', buf });
    return {
      message:
`${banner(nameForBanner, patientPhone)}

✅ 已記錄過敏明細
${fmtList(items)}

請輸入吸菸情形（例如：不吸菸／已戒菸／每日半包）。`
    };
  }

  // 吸菸
  if (state === 'SOCIAL_SMOKING_INPUT') {
    buf.history = buf.history || {};
    buf.history.social = buf.history.social || {};
    buf.history.social.smoking = fmtText(body);
    await writeHistSession(fromPhone, { state: 'SOCIAL_ALCOHOL_INPUT', buf });
    return {
      message:
`${banner(nameForBanner, patientPhone)}

✅ 已記錄吸菸：${fmtText(body)}

請輸入飲酒情形（例如：不飲酒／偶爾小酌／每週 2 次）。`
    };
  }

  // 飲酒
  if (state === 'SOCIAL_ALCOHOL_INPUT') {
    buf.history = buf.history || {};
    buf.history.social = buf.history.social || {};
    buf.history.social.alcohol = fmtText(body);
    await writeHistSession(fromPhone, { state: 'SOCIAL_TRAVEL_INPUT', buf });
    return {
      message:
`${banner(nameForBanner, patientPhone)}

✅ 已記錄飲酒：${fmtText(body)}

請輸入近期旅遊史（例如：無／上月赴日本 5 天）。`
    };
  }

  // 旅遊
  if (state === 'SOCIAL_TRAVEL_INPUT') {
    buf.history = buf.history || {};
    buf.history.social = buf.history.social || {};
    buf.history.social.travel = fmtText(body);

    // 寫入 Firestore
    const newHistory = buf.history;
    await writeHistory(fromPhone, patientId, newHistory);

    // 進入總結確認
    await writeHistSession(fromPhone, { state: 'REVIEW', buf: { history: newHistory } });
    return {
      message:
`${banner(nameForBanner, patientPhone)}

✅ 已儲存最新病史

${renderSummary(newHistory)}

是否需要更改？
1️⃣ 重新填寫
2️⃣ 下一步`
    };
  }

  // 總結確認
  if (state === 'REVIEW') {
    if (body === '1') {
      // 回到第一題重新填
      await writeHistSession(fromPhone, { state: 'PMH_INPUT', buf: {} });
      return {
        message:
`${banner(nameForBanner, patientPhone)}

請輸入過去病史（PMH），多項以「，」、「、」或換行分隔。`
      };
    }
    if (body === '2') {
      await writeHistSession(fromPhone, { state: 'ENTRY', buf: {} });
      return { message: '✅ 病史模組完成，進入下一步。', done: true };
    }
    return { message: '請輸入 1（重新填寫）或 2（下一步）。' };
  }

  // 兜底：重置回入口
  await writeHistSession(fromPhone, { state: 'ENTRY', buf: {} });
  return { message: '（提示）病史流程已重置，請重新開始本模組。' };
}

module.exports = { handleHistory };