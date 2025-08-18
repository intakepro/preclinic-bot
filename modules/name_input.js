// modules/name_input.js
// Version: v6.0.2-fs
// 目的：修正「首次進入 msg='' 就被判定 done:true」問題
// 介面：async handleNameInput({ req, from, msg }) -> { text, done }

'use strict';
const admin = require('firebase-admin');

// ---- Firebase init (once) ----
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

// ---- helpers ----
const phoneOf = (from) =>
  (from || '').toString().replace(/^whatsapp:/i, '').trim();

function isValidGender(t) { return t === '男' || t === '女'; }
function isValidDateYYYYMMDD(t) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const [y,m,d] = t.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, d));
  return dt.getUTCFullYear()===y && (dt.getUTCMonth()+1)===m && dt.getUTCDate()===d;
}
function isValidId(t) { return typeof t === 'string' && t.trim().length >= 4; }
function isBackKey(t) { return (t || '').trim() === '0'; }

function renderMenu(patients, firstTime=false) {
  const lines = [];
  if (firstTime || patients.length===0) {
    lines.push('👉 第 1 步：輸入病人名字模組');
    lines.push('此電話尚未有病人資料。請先新增（姓名→性別→出生日期→身份證）。');
    lines.push('');
    lines.push('回覆「1」開始新增。');
    return lines.join('\n');
  }
  lines.push('👉 第 1 步：輸入病人名字模組');
  lines.push('請選擇病人，或新增其他病人：');
  patients.forEach((p,i)=>lines.push(`${i+1}. ${p.name}`));
  lines.push(`${patients.length+1}. ➕ 新增病人`);
  lines.push('');
  lines.push('請回覆編號（例如：1）。');
  return lines.join('\n');
}
function renderDeleteMenu(patients){
  const lines = [];
  lines.push('📦 已達 8 人上限，請選擇要刪除的一位：');
  patients.forEach((p,i)=>lines.push(`${i+1}. ${p.name}`));
  lines.push('');
  lines.push('回覆對應編號刪除，或輸入 0 返回上一頁。');
  return lines.join('\n');
}
function renderProfile(p){
  return [
    '📄 病人個人資料',
    `姓名：${p.name}`,
    `性別：${p.gender}`,
    `出生日期：${p.birthDate}`,
    `身份證號碼：${p.idNumber}`
  ].join('\n');
}

// ---- Firestore I/O ----
async function ensureAccount(phone){
  const ref = db.collection('users').doc(phone);
  const s = await ref.get();
  const now = new Date();
  if (!s.exists) await ref.set({ phone, createdAt: now, updatedAt: now });
  else await ref.set({ updatedAt: now }, { merge: true });
}
async function listPatients(phone){
  const snap = await db.collection('users').doc(phone).collection('patients')
    .orderBy('createdAt','asc').get();
  const out=[]; snap.forEach(d=>out.push({ id:d.id, ...d.data() }));
  return out.slice(0,8);
}
async function addPatient(phone, data){
  const col = db.collection('users').doc(phone).collection('patients');
  const now = new Date();
  const payload = {
    name: data.name,
    gender: data.gender,
    birthDate: data.birthDate,
    idNumber: data.idNumber,
    createdAt: now, updatedAt: now
  };
  const ref = await col.add(payload);
  return { id: ref.id, ...payload };
}
async function deletePatient(phone, id){
  await db.collection('users').doc(phone).collection('patients').doc(id).delete();
}

// ---- Session（僅此模組用）----
async function getFSSession(phone){
  const ref = db.collection('sessions').doc(phone);
  const s = await ref.get();
  if (!s.exists) {
    const fresh = { phone, module:'name_input', state:'INIT', temp:{}, updatedAt:new Date() };
    await ref.set(fresh);
    return fresh;
  }
  const data = s.data() || {};
  data.phone = phone;
  return data;
}
async function saveFSSession(session){
  session.updatedAt = new Date();
  await db.collection('sessions').doc(session.phone).set(session, { merge:true });
}

// ---- 主處理器 ----
async function handleNameInput({ req, from, msg }) {
  const rawFrom = from || (req?.body?.From ?? '').toString();
  const phone = phoneOf(rawFrom);
  const body  = (msg ?? req?.body?.Body ?? '').toString().trim();

  if (!phone) return { text:'系統未能識別你的電話號碼，請透過 WhatsApp 連結重新進入。', done:false };

  try {
    // ★ 保險：首次進入（msg 空）時，絕不回 done:true，只給主選單/第一題
    if (!body) {
      await ensureAccount(phone);
      let session = await getFSSession(phone);
      let patients = await listPatients(phone);

      if (session.state === 'INIT' || patients.length === 0) {
        session.state = 'ADD_NAME';
        session.temp = {};
        await saveFSSession(session);
        return {
          text: '👉 第 1 步：輸入病人名字模組\n\n1️⃣ 請輸入姓名（身份證姓名）。\n（輸入 0 回上一頁）',
          done: false
        };
      }
      session.state = 'MENU';
      await saveFSSession(session);
      return { text: renderMenu(patients), done: false };
    }

    await ensureAccount(phone);
    let session = await getFSSession(phone);
    session.module = 'name_input';
    let patients = await listPatients(phone);

    // INIT
    if (session.state === 'INIT') {
      if (patients.length === 0) {
        session.state = 'ADD_NAME';
        session.temp = {};
        await saveFSSession(session);
        return { text:'首次使用：請輸入個人資料。\n\n1️⃣ 請輸入姓名（身份證姓名）。\n（輸入 0 回上一頁）', done:false };
      } else {
        session.state = 'MENU';
        await saveFSSession(session);
        return { text: renderMenu(patients), done:false };
      }
    }

    switch (session.state) {
      case 'MENU': {
        const n = Number(body);
        if (patients.length === 0) {
          session.state = 'ADD_NAME';
          session.temp = {};
          await saveFSSession(session);
          return { text:'首次使用：請輸入個人資料。\n\n1️⃣ 請輸入姓名（身份證姓名）。\n（輸入 0 回上一頁）', done:false };
        }
        if (Number.isInteger(n) && n >= 1 && n <= patients.length + 1) {
          if (n <= patients.length) {
            const chosen = patients[n - 1];
            // 交回 index：選定就算本步完成
            return { text: `${renderProfile(chosen)}\n\n✅ 已選擇此病人。`, done: true };
          }
          if (n === patients.length + 1) {
            if (patients.length >= 8) {
              session.state = 'DELETE_MENU';
              await saveFSSession(session);
              return { text:'⚠️ 已達 8 人上限，無法新增。\n\n' + renderDeleteMenu(patients), done:false };
            }
            session.state = 'ADD_NAME';
            session.temp = {};
            await saveFSSession(session);
            return { text:'1️⃣ 請輸入姓名（身份證姓名）。\n（輸入 0 回上一頁）', done:false };
          }
        }
        await saveFSSession(session);
        return { text: renderMenu(patients), done:false };
      }

      case 'ADD_NAME': {
        if (isBackKey(body)) {
          session.state = 'MENU';
          await saveFSSession(session);
          return { text: renderMenu(patients, patients.length===0), done:false };
        }
        if (!body) return { text:'請輸入有效的姓名（身份證姓名）。\n（輸入 0 回上一頁）', done:false };
        session.temp.name = body;
        session.state = 'ADD_GENDER';
        await saveFSSession(session);
        return { text:'2️⃣ 請輸入性別（回覆「男」或「女」）。\n（輸入 0 回上一頁）', done:false };
      }

      case 'ADD_GENDER': {
        if (isBackKey(body)) {
          session.state = 'ADD_NAME';
          await saveFSSession(session);
          return { text:'1️⃣ 請輸入姓名（身份證姓名）。\n（輸入 0 回上一頁）', done:false };
        }
        if (!isValidGender(body)) return { text:'格式不正確。請回覆「男」或「女」。\n（輸入 0 回上一頁）', done:false };
        session.temp.gender = body;
        session.state = 'ADD_DOB';
        await saveFSSession(session);
        return { text:'3️⃣ 請輸入出生日期（YYYY-MM-DD，例如：1978-01-21）。\n（輸入 0 回上一頁）', done:false };
      }

      case 'ADD_DOB': {
        if (isBackKey(body)) {
          session.state = 'ADD_GENDER';
          await saveFSSession(session);
          return { text:'2️⃣ 請輸入性別（回覆「男」或「女」）。\n（輸入 0 回上一頁）', done:false };
        }
        if (!isValidDateYYYYMMDD(body)) return { text:'出生日期格式不正確。請用 YYYY-MM-DD（例如：1978-01-21）。\n（輸入 0 回上一頁）', done:false };
        session.temp.birthDate = body;
        session.state = 'ADD_ID';
        await saveFSSession(session);
        return { text:'4️⃣ 請輸入身份證號碼：\n（輸入 0 回上一頁）', done:false };
      }

      case 'ADD_ID': {
        if (isBackKey(body)) {
          session.state = 'ADD_DOB';
          await saveFSSession(session);
          return { text:'3️⃣ 請輸入出生日期（YYYY-MM-DD，例如：1978-01-21）。\n（輸入 0 回上一頁）', done:false };
        }
        if (!isValidId(body)) return { text:'身份證號碼不正確，請重新輸入（至少 4 個字元）。\n（輸入 0 回上一頁）', done:false };

        patients = await listPatients(phone);
        if (patients.length >= 8) {
          session.state = 'DELETE_MENU';
          await saveFSSession(session);
          return { text:'⚠️ 已達 8 人上限，無法新增。\n\n' + renderDeleteMenu(patients), done:false };
        }

        session.temp.idNumber = body;
        const created = await addPatient(phone, session.temp);

        session.state = 'MENU';
        session.temp = {};
        await saveFSSession(session);

        return { text:`💾 已儲存。\n\n${renderProfile(created)}\n\n✅ 已選擇此病人。`, done:true };
      }

      case 'DELETE_MENU': {
        if (isBackKey(body)) {
          session.state = 'MENU';
          await saveFSSession(session);
          return { text: renderMenu(patients), done:false };
        }
        const n = Number(body);
        if (Number.isInteger(n) && n >=1 && n <= patients.length) {
          const target = patients[n-1];
          await deletePatient(phone, target.id);
          session.state = 'MENU';
          await saveFSSession(session);
          const after = await listPatients(phone);
          return { text:`🗑️ 已刪除：${target.name}\n\n${renderMenu(after)}`, done:false };
        }
        return { text: renderDeleteMenu(patients), done:false };
      }

      default: {
        session.state = 'MENU';
        await saveFSSession(session);
        return { text: renderMenu(patients, patients.length===0), done:false };
      }
    }
  } catch (err) {
    console.error('[name_input] error:', err?.stack || err);
    return { text:'系統暫時忙碌，請稍後再試。', done:false };
  }
}

module.exports = { handleNameInput };