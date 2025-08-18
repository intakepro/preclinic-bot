/**
 * Module: modules/name_input.js
 * Version: v6.0.0-firestore
 * 介面：async handleNameInput({ msg, from }) -> { text: string, done: boolean }
 *
 * 說明：
 * - 配合 index v6.0.0：模組不直接 res.send；只回 { text, done }。
 * - Firestore：
 *    - users/{phone}/patients/*        : 病人清單
 *    - name_input_sessions/{phone}     : 本模組的對話狀態
 * - 所有「顯示完資料」的停頓點，均提供：
 *    1＝需要更改，z＝進入下一步
 */

'use strict';

const admin = require('firebase-admin');

// ---------- Firebase 初始化 ----------
(function ensureFirebase() {
  if (admin.apps.length) return;
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      console.log('[name_input] Firebase initialized via FIREBASE_SERVICE_ACCOUNT');
    } else {
      admin.initializeApp(); // 使用預設憑證
      console.log('[name_input] Firebase initialized via default credentials');
    }
  } catch (e) {
    console.error('[name_input] Firebase init error:', e?.message || e);
    throw e;
  }
})();
const db = admin.firestore();
const nowTS = () => admin.firestore.FieldValue.serverTimestamp();

// ---------- 狀態 ----------
const STATES = {
  INIT: 'N_INIT',
  MENU: 'N_MENU',
  SHOW_SELECTED: 'N_SHOW_SELECTED',
  ADD_NAME: 'N_ADD_NAME',
  ADD_GENDER: 'N_ADD_GENDER',
  ADD_DOB: 'N_ADD_DOB',
  ADD_ID: 'N_ADD_ID',
  CONFIRM_NEW: 'N_CONFIRM_NEW', // 顯示新建/更新後的資料 -> 1 更改 / z 下一步
};

function userKey(from) {
  return (from || '').toString().replace(/^whatsapp:/i, '').trim() || 'DEFAULT';
}

// ---------- Firestore I/O ----------
async function ensureAccount(phone) {
  const ref = db.collection('users').doc(phone);
  const s = await ref.get();
  if (!s.exists) await ref.set({ phone, createdAt: nowTS(), updatedAt: nowTS() });
  else await ref.set({ updatedAt: nowTS() }, { merge: true });
}
async function getSession(phone) {
  const ref = db.collection('name_input_sessions').doc(phone);
  const snap = await ref.get();
  if (snap.exists) return snap.data();
  const fresh = { state: STATES.INIT, temp: {}, selectedId: null, updatedAt: nowTS() };
  await ref.set(fresh);
  return fresh;
}
async function saveSession(phone, patch) {
  await db.collection('name_input_sessions').doc(phone)
    .set({ ...patch, updatedAt: nowTS() }, { merge: true });
}

async function listPatients(phone) {
  const snap = await db.collection('users').doc(phone)
    .collection('patients').orderBy('createdAt', 'asc').get();
  const arr = [];
  snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
  return arr.slice(0, 8);
}
async function getPatient(phone, pid) {
  if (!pid) return null;
  const doc = await db.collection('users').doc(phone).collection('patients').doc(pid).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}
async function addPatient(phone, data) {
  const col = db.collection('users').doc(phone).collection('patients');
  const payload = { ...data, createdAt: nowTS(), updatedAt: nowTS() };
  const ref = await col.add(payload);
  return { id: ref.id, ...data };
}
async function updatePatient(phone, pid, data) {
  await db.collection('users').doc(phone).collection('patients').doc(pid)
    .set({ ...data, updatedAt: nowTS() }, { merge: true });
}

async function deletePatient(phone, pid) {
  await db.collection('users').doc(phone).collection('patients').doc(pid).delete();
}

// ---------- 驗證 & UI ----------
function isValidGender(t) { return t === '男' || t === '女'; }
function isValidDateYYYYMMDD(t) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const [y, m, d] = t.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y &&
         (dt.getUTCMonth() + 1) === m &&
         dt.getUTCDate() === d &&
         y >= 1900 && y <= 2100;
}
function isValidId(t) { return typeof t === 'string' && t.trim().length >= 4; }
function isZ(input) { return typeof input === 'string' && /^z$/i.test(input.trim()); }

function renderMenu(list) {
  if (!list.length) {
    return [
      '👉 第 1 步：輸入病人名字模組',
      '此電話尚未有病人資料。',
      '請選擇操作：',
      '1️⃣ 新增病人',
      'z️⃣ 不新增，進入下一步'
    ].join('\n');
  }
  const lines = [];
  lines.push('👉 第 1 步：輸入病人名字模組');
  lines.push('請選擇病人，或新增：');
  list.forEach((p, i) => lines.push(`${i + 1}️⃣ ${p.name}`));
  lines.push(`${list.length + 1}️⃣ ➕ 新增病人`);
  lines.push('z️⃣ 不變更，進入下一步');
  return lines.join('\n');
}
function renderProfile(p) {
  return [
    '📄 病人個人資料',
    `姓名：${p.name}`,
    `性別：${p.gender}`,
    `出生日期：${p.birthDate}`,
    `身份證：${p.idNumber}`
  ].join('\n');
}

// ---------- 主處理器 ----------
async function handleNameInput({ msg, from }) {
  const phone = userKey(from);
  const body = (msg || '').trim();

  if (!phone || phone === 'DEFAULT') {
    return { text: '未能識別使用者（缺少 from/電話），請從 WhatsApp 重新進入。', done: false };
  }

  try {
    await ensureAccount(phone);
    let session = await getSession(phone);
    let patients = await listPatients(phone);

    // 入口
    if (session.state === STATES.INIT) {
      session.state = STATES.MENU;
      await saveSession(phone, session);
      return { text: renderMenu(patients), done: false };
    }

    // 選單：選擇既有 / 新增 / 跳過
    if (session.state === STATES.MENU) {
      if (isZ(body)) {
        // 不變更 → 直接完成
        session.state = STATES.INIT;
        await saveSession(phone, session);
        return { text: '✅ 未更改病人資料，將進入下一步。', done: true };
      }

      const n = Number(body);
      if (Number.isInteger(n)) {
        if (patients.length === 0) {
          if (n === 1) {
            session.state = STATES.ADD_NAME;
            session.temp = {};
            await saveSession(phone, session);
            return { text: '1️⃣ 請輸入姓名（身份證姓名）', done: false };
          }
          return { text: renderMenu(patients), done: false };
        }

        if (n >= 1 && n <= patients.length) {
          const chosen = patients[n - 1];
          session.selectedId = chosen.id;
          session.state = STATES.SHOW_SELECTED;
          await saveSession(phone, session);
          return {
            text: `${renderProfile(chosen)}\n\n是否需要更改？\n1️⃣ 需要更改\nz️⃣ 進入下一步`,
            done: false
          };
        }

        if (n === patients.length + 1) {
          if (patients.length >= 8) {
            return { text: `⚠️ 已達 8 人上限，請先刪除一位再新增。`, done: false };
          }
          session.state = STATES.ADD_NAME;
          session.temp = {};
          await saveSession(phone, session);
          return { text: '1️⃣ 請輸入姓名（身份證姓名）', done: false };
        }
      }

      return { text: renderMenu(patients), done: false };
    }

    // 顯示所選個人資料：1 更改 / z 下一步
    if (session.state === STATES.SHOW_SELECTED) {
      if (isZ(body)) {
        // 確認不更改 → 完成本步
        session.state = STATES.INIT;
        await saveSession(phone, session);
        return { text: '✅ 已確認資料，將進入下一步。', done: true };
      }
      if (body === '1') {
        // 進入編輯流程（覆寫）
        session.state = STATES.ADD_NAME;
        session.temp = {};
        await saveSession(phone, session);
        return { text: '1️⃣ 請輸入姓名（身份證姓名）', done: false };
      }
      const p = await getPatient(phone, session.selectedId);
      return {
        text: `${renderProfile(p || { name:'', gender:'', birthDate:'', idNumber:'' })}\n\n是否需要更改？\n1️⃣ 需要更改\nz️⃣ 進入下一步`,
        done: false
      };
    }

    // ===== 建立 / 更新 流程 =====
    if (session.state === STATES.ADD_NAME) {
      if (!body) return { text: '請輸入有效的姓名。', done: false };
      session.temp.name = body;
      session.state = STATES.ADD_GENDER;
      await saveSession(phone, session);
      return { text: '2️⃣ 請輸入性別（回覆「男」或「女」）', done: false };
    }

    if (session.state === STATES.ADD_GENDER) {
      if (!isValidGender(body)) return { text: '格式不正確。請回覆「男」或「女」。', done: false };
      session.temp.gender = body;
      session.state = STATES.ADD_DOB;
      await saveSession(phone, session);
      return { text: '3️⃣ 請輸入出生日期（YYYY-MM-DD，例如 1978-01-21）', done: false };
    }

    if (session.state === STATES.ADD_DOB) {
      if (!isValidDateYYYYMMDD(body)) {
        return { text: '出生日期格式不正確。請用 YYYY-MM-DD（例如 1978-01-21）。', done: false };
      }
      session.temp.birthDate = body;
      session.state = STATES.ADD_ID;
      await saveSession(phone, session);
      return { text: '4️⃣ 請輸入身份證號碼（至少 4 個字元）', done: false };
    }

    if (session.state === STATES.ADD_ID) {
      if (!isValidId(body)) {
        return { text: '身份證號碼不正確，請重新輸入（至少 4 個字元）。', done: false };
      }
      session.temp.idNumber = body;

      // 決定新增或更新
      let createdOrUpdated;
      if (session.selectedId) {
        // 覆寫現有病人
        await updatePatient(phone, session.selectedId, session.temp);
        createdOrUpdated = await getPatient(phone, session.selectedId);
      } else {
        // 新增（先檢查名額）
        const list = await listPatients(phone);
        if (list.length >= 8) {
          session.state = STATES.MENU;
          session.temp = {};
          await saveSession(phone, session);
          return { text: '⚠️ 已達 8 人上限，無法新增。請於選單刪除後再試。', done: false };
        }
        createdOrUpdated = await addPatient(phone, session.temp);
        session.selectedId = createdOrUpdated.id;
      }

      session.state = STATES.CONFIRM_NEW;
      await saveSession(phone, session);
      return {
        text: `💾 已儲存。\n\n${renderProfile(createdOrUpdated)}\n\n是否需要更改？\n1️⃣ 需要更改\nz️⃣ 進入下一步`,
        done: false
      };
    }

    if (session.state === STATES.CONFIRM_NEW) {
      if (isZ(body)) {
        // 完成本步
        session.state = STATES.INIT;
        await saveSession(phone, session);
        return { text: '✅ 個人資料已確認，將進入下一步。', done: true };
      }
      if (body === '1') {
        // 再次修改
        session.state = STATES.ADD_NAME;
        session.temp = {};
        await saveSession(phone, session);
        return { text: '請輸入新的姓名（身份證姓名）', done: false };
      }
      const p = await getPatient(phone, session.selectedId);
      return {
        text: `請回覆：\n1️⃣ 需要更改\nz️⃣ 進入下一步\n\n${renderProfile(p || { name:'', gender:'', birthDate:'', idNumber:'' })}`,
        done: false
      };
    }

    // 兜底：回選單
    session.state = STATES.MENU;
    await saveSession(phone, session);
    patients = await listPatients(phone);
    return { text: renderMenu(patients), done: false };

  } catch (err) {
    console.error('[name_input] error:', err?.stack || err);
    return { text: '系統暫時忙碌，請稍後再試。', done: false };
  }
}

module.exports = { handleNameInput };