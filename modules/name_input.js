/**
 * Module: modules/name_input.js
 * Version: v2025-08-17-02
 * Date: 2025-08-17
 * 變更摘要：
 * - 統一回傳 { replied, autoNext }，完成時 autoNext:true，與 index.js 的 autoNext 流程對接
 * - 每一道問題均支援「回上一項」：輸入 0 / prev / ←
 * - 除非等待使用者輸入，否則完成即自動跳下一步（選現有病人 / 新增完成）
 * - 文案加入「回上一項」提示
 */

const { MessagingResponse } = require('twilio').twiml;
const admin = require('firebase-admin');

// -------- Firebase 初始化（只初始化一次） --------
let _initialized = false;
function ensureFirebase() {
  if (_initialized) return;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      console.log('[name_input] Firebase via FIREBASE_SERVICE_ACCOUNT');
    } catch (e) {
      console.error('[name_input] FIREBASE_SERVICE_ACCOUNT JSON parse failed:', e.message);
      admin.initializeApp();
    }
  } else {
    admin.initializeApp();
    console.log('[name_input] Firebase via default credentials');
  }
  _initialized = true;
}
function db() { ensureFirebase(); return admin.firestore(); }

// -------- Firestore I/O --------
async function ensureAccount(phone) {
  const userRef = db().collection('users').doc(phone);
  const s = await userRef.get();
  if (!s.exists) await userRef.set({ phone, createdAt: new Date(), updatedAt: new Date() });
  else await userRef.set({ updatedAt: new Date() }, { merge: true });
}
async function listPatients(phone) {
  const snap = await db().collection('users').doc(phone).collection('patients')
    .orderBy('createdAt', 'asc').get();
  const out = []; snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out.slice(0, 8);
}
async function addPatient(phone, data) {
  const col = db().collection('users').doc(phone).collection('patients');
  const now = new Date();
  const payload = {
    name: data.name,
    gender: data.gender,        // '男' | '女'
    birthDate: data.birthDate,  // 'YYYY-MM-DD'
    idNumber: data.idNumber,
    createdAt: now,
    updatedAt: now
  };
  const ref = await col.add(payload);
  return { id: ref.id, ...payload };
}
async function deletePatient(phone, patientId) {
  await db().collection('users').doc(phone).collection('patients').doc(patientId).delete();
}

// -------- Session in Firestore（只給本模組使用） --------
async function getFSSession(phone) {
  const ref = db().collection('sessions').doc(phone);
  const snap = await ref.get();
  if (!snap.exists) {
    const fresh = {
      phone,
      module: 'name_input',
      state: 'INIT', // INIT | MENU | ADD_NAME | ADD_GENDER | ADD_DOB | ADD_ID | DELETE_MENU
      temp: {},
      updatedAt: new Date()
    };
    await ref.set(fresh);
    return fresh;
  }
  const data = snap.data() || {};
  data.phone = phone; // 防舊資料污染
  return data;
}
async function saveFSSession(session) {
  if (!session || !session.phone || !session.phone.trim()) {
    throw new Error(`name_input.saveFSSession invalid phone: ${session && session.phone}`);
  }
  session.updatedAt = new Date();
  await db().collection('sessions').doc(session.phone).set(session, { merge: true });
}

// -------- 驗證 & UI --------
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
function isBackKey(t) {
  const v = (t || '').trim().toLowerCase();
  return v === '0' || v === 'prev' || v === '←';
}

function renderMenu(patients, firstTime = false) {
  const lines = [];
  if (firstTime || patients.length === 0) {
    lines.push('此電話尚未有病人資料。請先新增個人資料（依序：姓名→性別→出生日期→身份證號）。');
    lines.push('');
    lines.push('回覆「1」開始新增。');
    return lines.join('\n');
  }
  lines.push('👤 請選擇病人，或新增其他病人：');
  patients.forEach((p, i) => lines.push(`${i + 1}. ${p.name}`));
  lines.push(`${patients.length + 1}. ➕ 新增病人`);
  lines.push('');
  lines.push('請回覆編號（例如：1）。（回上一項：輸入 0 / prev / ←）');
  return lines.join('\n');
}
function renderDeleteMenu(patients) {
  const lines = [];
  lines.push('📦 已達最多 8 人限制時，請先刪除一位：');
  patients.forEach((p, i) => lines.push(`${i + 1}. ${p.name}`));
  lines.push('');
  lines.push('回覆對應編號刪除；回上一項：輸入 0 / prev / ←');
  return lines.join('\n');
}
function renderProfile(p) {
  return [
    '📄 病人個人資料',
    `姓名：${p.name}`,
    `性別：${p.gender}`,
    `出生日期：${p.birthDate}`,
    `身份證號碼：${p.idNumber}`
  ].join('\n');
}

// -------- 主處理器 --------
// args: { req, res, from, msg, onComplete({ phone, patientId, name }), advanceNext() }
async function handleNameInput(args) {
  const { req, res, from, msg, onComplete, advanceNext } = args;
  const twiml = new MessagingResponse();

  const rawFrom = from || (req.body?.From ?? req.body?.FromNumber ?? '').toString();
  const phone = rawFrom.replace(/^whatsapp:/i, '').trim();
  const body  = (msg ?? req.body?.Body ?? '').toString().trim();

  if (!phone) {
    twiml.message('系統未能識別你的電話號碼，請透過 WhatsApp 連結重新進入。');
    res.type('text/xml').send(twiml.toString());
    return { replied: true, autoNext: false };
  }

  try {
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
        twiml.message('1️⃣ 請輸入姓名（身份證姓名）。\n（回上一項：輸入 0 / prev / ←）');
        res.type('text/xml').send(twiml.toString());
        return { replied: true, autoNext: false }; // 等用戶輸入
      } else {
        session.state = 'MENU';
        await saveFSSession(session);
        twiml.message(renderMenu(patients));
        res.type('text/xml').send(twiml.toString());
        return { replied: true, autoNext: false }; // 等用戶選擇
      }
    }

    switch (session.state) {
      case 'MENU': {
        if (isBackKey(body)) {
          // MENU 已是第一層，回上一項=維持在 MENU
          twiml.message(renderMenu(patients, patients.length === 0));
          res.type('text/xml').send(twiml.toString());
          return { replied: true, autoNext: false };
        }
        const n = Number(body);
        if (patients.length === 0) {
          session.state = 'ADD_NAME';
          session.temp = {};
          await saveFSSession(session);
          twiml.message('1️⃣ 請輸入姓名（身份證姓名）。\n（回上一項：輸入 0 / prev / ←）');
          res.type('text/xml').send(twiml.toString());
          return { replied: true, autoNext: false };
        }
        if (Number.isInteger(n) && n >= 1 && n <= patients.length + 1) {
          if (n <= patients.length) {
            const chosen = patients[n - 1];
            if (typeof onComplete === 'function') {
              onComplete({ phone, patientId: chosen.id, name: chosen.name });
            }
            twiml.message(`${renderProfile(chosen)}\n\n✅ 已選擇此病人，將進入下一步。`);
            res.type('text/xml').send(twiml.toString());
            if (typeof advanceNext === 'function') advanceNext();
            return { replied: true, autoNext: true }; // ✅ 自動下一步
          }
          // 新增
          if (n === patients.length + 1) {
            if (patients.length >= 8) {
              session.state = 'DELETE_MENU';
              await saveFSSession(session);
              twiml.message('⚠️ 已達 8 人上限，無法新增。\n\n' + renderDeleteMenu(patients));
              res.type('text/xml').send(twiml.toString());
              return { replied: true, autoNext: false };
            }
            session.state = 'ADD_NAME';
            session.temp = {};
            await saveFSSession(session);
            twiml.message('1️⃣ 請輸入姓名（身份證姓名）。\n（回上一項：輸入 0 / prev / ←）');
            res.type('text/xml').send(twiml.toString());
            return { replied: true, autoNext: false };
          }
        }
        await saveFSSession(session);
        twiml.message(renderMenu(patients));
        res.type('text/xml').send(twiml.toString());
        return { replied: true, autoNext: false };
      }

      case 'ADD_NAME': {
        if (isBackKey(body)) {
          session.state = 'MENU';
          await saveFSSession(session);
          twiml.message(renderMenu(patients, patients.length === 0));
          res.type('text/xml').send(twiml.toString());
          return { replied: true, autoNext: false };
        }
        if (!body) {
          twiml.message('請輸入有效的姓名（身份證姓名）。\n（回上一項：輸入 0 / prev / ←）');
          res.type('text/xml').send(twiml.toString());
          return { replied: true, autoNext: false };
        }
        session.temp.name = body;
        session.state = 'ADD_GENDER';
        await saveFSSession(session);
        twiml.message('2️⃣ 請輸入性別（回覆「男」或「女」）。\n（回上一項：輸入 0 / prev / ←）');
        res.type('text/xml').send(twiml.toString());
        return { replied: true, autoNext: false };
      }

      case 'ADD_GENDER': {
        if (isBackKey(body)) {
          session.state = 'ADD_NAME';
          await saveFSSession(session);
          twiml.message('1️⃣ 請輸入姓名（身份證姓名）。\n（回上一項：輸入 0 / prev / ←）');
        } else if (!isValidGender(body)) {
          twiml.message('格式不正確。請回覆「男」或「女」。\n（回上一項：輸入 0 / prev / ←）');
        } else {
          session.temp.gender = body;
          session.state = 'ADD_DOB';
          await saveFSSession(session);
          twiml.message('3️⃣ 請輸入出生日期（YYYY-MM-DD，例如：1978-01-21）。\n（回上一項：輸入 0 / prev / ←）');
        }
        res.type('text/xml').send(twiml.toString());
        return { replied: true, autoNext: false };
      }

      case 'ADD_DOB': {
        if (isBackKey(body)) {
          session.state = 'ADD_GENDER';
          await saveFSSession(session);
          twiml.message('2️⃣ 請輸入性別（回覆「男」或「女」）。\n（回上一項：輸入 0 / prev / ←）');
        } else if (!isValidDateYYYYMMDD(body)) {
          twiml.message('出生日期格式不正確。請用 YYYY-MM-DD（例如：1978-01-21）。\n（回上一項：輸入 0 / prev / ←）');
        } else {
          session.temp.birthDate = body;
          session.state = 'ADD_ID';
          await saveFSSession(session);
          twiml.message('4️⃣ 請輸入身份證號碼：\n（回上一項：輸入 0 / prev / ←）');
        }
        res.type('text/xml').send(twiml.toString());
        return { replied: true, autoNext: false };
      }

      case 'ADD_ID': {
        if (isBackKey(body)) {
          session.state = 'ADD_DOB';
          await saveFSSession(session);
          twiml.message('3️⃣ 請輸入出生日期（YYYY-MM-DD，例如：1978-01-21）。\n（回上一項：輸入 0 / prev / ←）');
          res.type('text/xml').send(twiml.toString());
          return { replied: true, autoNext: false };
        }
        if (!isValidId(body)) {
          twiml.message('身份證號碼不正確，請重新輸入（至少 4 個字元）。\n（回上一項：輸入 0 / prev / ←）');
          res.type('text/xml').send(twiml.toString());
          return { replied: true, autoNext: false };
        }

        // 寫入（避免競態先確認名額）
        patients = await listPatients(phone);
        if (patients.length >= 8) {
          session.state = 'DELETE_MENU';
          await saveFSSession(session);
          twiml.message('⚠️ 已達 8 人上限，無法新增。\n\n' + renderDeleteMenu(patients));
          res.type('text/xml').send(twiml.toString());
          return { replied: true, autoNext: false };
        }

        session.temp.idNumber = body;
        const created = await addPatient(phone, session.temp);

        // 清暫存 → 回主選單
        session.state = 'MENU';
        session.temp = {};
        await saveFSSession(session);

        // 回傳完成（把新建的病人當作選取）
        if (typeof onComplete === 'function') {
          onComplete({ phone, patientId: created.id, name: created.name });
        }
        twiml.message(`💾 已儲存。\n\n${renderProfile(created)}\n\n✅ 已選擇此病人，將進入下一步。`);
        res.type('text/xml').send(twiml.toString());
        if (typeof advanceNext === 'function') advanceNext(); // 兼容舊版
        return { replied: true, autoNext: true };             // ✅ 自動下一步
      }

      case 'DELETE_MENU': {
        if (isBackKey(body)) {
          session.state = 'MENU';
          await saveFSSession(session);
          twiml.message(renderMenu(patients));
          res.type('text/xml').send(twiml.toString());
          return { replied: true, autoNext: false };
        }
        const n = Number(body);
        if (Number.isInteger(n) && n >= 1 && n <= patients.length) {
          const target = patients[n - 1];
          await deletePatient(phone, target.id);
          session.state = 'MENU';
          await saveFSSession(session);
          const after = await listPatients(phone);
          twiml.message(`🗑️ 已刪除：${target.name}\n\n${renderMenu(after)}`);
          res.type('text/xml').send(twiml.toString());
          return { replied: true, autoNext: false }; // 刪除後仍需選擇，不自動跳下一模組
        }
        twiml.message(renderDeleteMenu(patients));
        res.type('text/xml').send(twiml.toString());
        return { replied: true, autoNext: false };
      }

      default: {
        session.state = 'MENU';
        await saveFSSession(session);
        twiml.message(renderMenu(patients, patients.length === 0));
        res.type('text/xml').send(twiml.toString());
        return { replied: true, autoNext: false };
      }
    }
  } catch (err) {
    console.error('[name_input] error:', err && err.stack ? err.stack : err);
    const twiml2 = new MessagingResponse();
    twiml2.message('系統暫時忙碌，請稍後再試。');
    res.type('text/xml').send(twiml2.toString());
    return { replied: true, autoNext: false };
  }
}

module.exports = { handleNameInput };
