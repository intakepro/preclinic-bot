/**
 * File: modules/name_input.js
 * Version: v6.0.1-fs
 * Interface: async handleNameInput({ msg, from }) -> { text, done }
 *
 * 更新內容：
 * - 新增 resetHistorySession(phone, patientId)：當選擇/新增病人後，清除該病人的 history_sessions，
 *   以確保進入 History 時會顯示「既有病史摘要 + 1/ z 選項」，而不是殘留在 DONE。
 */

'use strict';

const admin = require('firebase-admin');

// --- Firebase ---
(function ensureFirebase() {
  if (admin.apps.length) return;
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      console.log('[name_input] Firebase via FIREBASE_SERVICE_ACCOUNT');
    } else {
      admin.initializeApp();
      console.log('[name_input] Firebase via default credentials');
    }
  } catch (e) {
    console.error('[name_input] Firebase init error:', e?.message || e);
    throw e;
  }
})();
const db = admin.firestore();
const nowTS = () => admin.firestore.FieldValue.serverTimestamp();

const phoneKey = (from) =>
  (from || '').toString().replace(/^whatsapp:/i, '').trim() || 'DEFAULT';

const STATES = {
  ENTRY: 'NI_ENTRY',
  MENU: 'NI_MENU',
  ADD_NAME: 'NI_ADD_NAME',
  DONE: 'NI_DONE'
};

async function getNiSession(phone) {
  const ref = db.collection('ni_sessions').doc(phone);
  const s = await ref.get();
  if (s.exists) return s.data();
  const fresh = { state: STATES.ENTRY, buffer: {}, updatedAt: nowTS() };
  await ref.set(fresh);
  return fresh;
}
async function saveNiSession(phone, patch) {
  await db.collection('ni_sessions').doc(phone)
    .set({ ...patch, updatedAt: nowTS() }, { merge: true });
}

async function listPatients(phone) {
  const snap = await db.collection('users').doc(phone).collection('patients')
    .orderBy('createdAt', 'asc').limit(8).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function createPatient(phone, name) {
  const ref = db.collection('users').doc(phone).collection('patients').doc(); // 自動 ID
  const now = nowTS();
  await ref.set({ name, createdAt: now, updatedAt: now });
  return { id: ref.id, name };
}
async function touchSelectedPatient(phone, sel) {
  // 寫入全局 sessions/{phone} 供 index & 其他模組使用
  await db.collection('sessions').doc(phone)
    .set({ selectedPatient: { patientId: sel.patientId, name: sel.name }, updatedAt: nowTS() }, { merge: true });
}

// 🔧 新增：重置該病人的 History Session
async function resetHistorySession(phone, patientId) {
  const historyKey = `${phone}__${patientId}`;
  await db.collection('history_sessions').doc(historyKey).delete().catch(() => {});
}

function renderMenu(patients) {
  if (!patients.length) {
    return [
      '👤 尚未有病人資料。',
      '回覆「1」新增病人。'
    ].join('\n');
  }
  const lines = ['👤 請選擇病人，或新增其他病人：'];
  patients.forEach((p, i) => lines.push(`${i + 1}. ${p.name}`));
  lines.push(`${patients.length + 1}. ➕ 新增病人`);
  lines.push('', '請回覆編號（例如：1）。');
  return lines.join('\n');
}

module.exports.handleNameInput = async function handleNameInput({ msg, from }) {
  const phone = phoneKey(from);
  const body  = (msg || '').trim();

  let session = await getNiSession(phone);
  let patients = await listPatients(phone);

  // 入口
  if (session.state === STATES.ENTRY) {
    session.state = STATES.MENU;
    await saveNiSession(phone, { state: session.state });
    return { text: renderMenu(patients), done: false };
  }

  // 選單
  if (session.state === STATES.MENU) {
    const n = parseInt(body, 10);
    if (!Number.isInteger(n) || n < 1 || n > patients.length + 1) {
      return { text: renderMenu(patients), done: false };
    }
    // 選擇現有
    if (n <= patients.length) {
      const chosen = patients[n - 1];
      const sel = { patientId: chosen.id, name: chosen.name };
      await touchSelectedPatient(phone, sel);

      // ⭐ 重點：重置該病人的 History session，避免殘留在 DONE
      await resetHistorySession(phone, sel.patientId);

      session.state = STATES.DONE;
      await saveNiSession(phone, { state: session.state, buffer: {} });
      return {
        text:
`📄 已選擇病人：
姓名：${chosen.name}
（如需改選，輸入 restart 後重來）

✅ 將進入下一步。`,
        done: true
      };
    }
    // 新增
    session.state = STATES.ADD_NAME;
    await saveNiSession(phone, { state: session.state, buffer: {} });
    return { text: '請輸入新病人姓名：', done: false };
  }

  // 新增姓名
  if (session.state === STATES.ADD_NAME) {
    if (!body) return { text: '請輸入有效姓名：', done: false };
    const created = await createPatient(phone, body);
    const sel = { patientId: created.id, name: created.name };
    await touchSelectedPatient(phone, sel);

    // ⭐ 新增病人後也重置（確保首次會走完整流程）
    await resetHistorySession(phone, sel.patientId);

    session.state = STATES.DONE;
    await saveNiSession(phone, { state: session.state, buffer: {} });
    return {
      text:
`💾 已新增病人並選取：
姓名：${created.name}

✅ 將進入下一步。`,
      done: true
    };
  }

  // DONE
  return { text: '（提示）此步已完成。如需重來請輸入 restart。', done: true };
};