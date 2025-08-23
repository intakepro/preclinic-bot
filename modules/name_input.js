//  modules/name_input.js
// Version: 7 → 7.1 (增強：更改資料時逐題顯示原值；輸入「1」保留；輸入新值覆蓋)
// 介面：async handleNameInput({ req, from, msg }) -> { text, done }

'use strict';
const admin = require('firebase-admin');

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

const phoneOf = (from) => (from || '').toString().replace(/^whatsapp:/i, '').trim();

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
  lines.push('👉 第 1 步：輸入病人名字模組');
  if (firstTime || patients.length===0) {
    lines.push('此電話尚未有病人資料。請先新增（姓名→性別→出生日期→身份證）。');
    lines.push('');
    lines.push('回覆「1」開始新增。');
    lines.push('0️⃣ 返回上一題');
    return lines.join('\n');
  }
  lines.push('請選擇病人，或新增其他病人：');
  patients.forEach((p,i)=>lines.push(`${i+1}. ${p.name}`));
  lines.push(`${patients.length+1}. ➕ 新增病人`);
  lines.push('');
  lines.push('請回覆編號（例如：1）。');
  lines.push('0️⃣ 返回上一題');
  return lines.join('\n');
}
function renderDeleteMenu(patients){
  const lines = [];
  lines.push('📦 已達 8 人上限，請選擇要刪除的一位：');
  patients.forEach((p,i)=>lines.push(`${i+1}. ${p.name}`));
  lines.push('');
  lines.push('回覆對應編號刪除。');
  lines.push('0️⃣ 返回上一題');
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

/** 🔧 新增：讀取/更新病人 + 編輯提示文字 **/
async function getPatient(phone, patientId){
  const ref = db.collection('users').doc(phone).collection('patients').doc(patientId);
  const s = await ref.get();
  return s.exists ? { id: s.id, ...s.data() } : null;
}
async function updatePatient(phone, patientId, updates){
  updates.updatedAt = new Date();
  await db.collection('users').doc(phone).collection('patients').doc(patientId).set(updates, { merge:true });
}
function renderEditPrompt(field, originVal){
  const labelMap = {
    name: '姓名（身份證姓名）',
    gender: '性別（回覆「男」或「女」）',
    birthDate: '出生日期（YYYY-MM-DD）',
    idNumber: '身份證號碼'
  };
  const safe = (originVal ?? '').toString() || '（無資料）';
  return [
    `請輸入新的${labelMap[field]}：`,
    `（輸入「1」可保留原值：${safe}）`,
    '0️⃣ 返回上一題'
  ].join('\n');
}

// 使用者/病人/Session（原樣保留）
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

// 專用 session（原樣保留）
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

async function handleNameInput({ req, from, msg }) {
  const rawFrom = from || (req?.body?.From ?? '').toString();
  const phone = phoneOf(rawFrom);
  const body  = (msg ?? req?.body?.Body ?? '').toString().trim();

  if (!phone) return { text:'系統未能識別你的電話號碼，請透過 WhatsApp 連結重新進入。', done:false };

  try {
    if (!body) {
      await ensureAccount(phone);
      let session = await getFSSession(phone);
      let patients = await listPatients(phone);

      if (session.state === 'INIT' || patients.length === 0) {
        session.state = 'ADD_NAME';
        session.temp = {};
        await saveFSSession(session);
        return { text: '👉 第 1 步：輸入病人名字模組\n\n1️⃣ 請輸入姓名（身份證姓名）。\n0️⃣ 返回上一題', done: false };
      }
      session.state = 'MENU';
      await saveFSSession(session);
      return { text: renderMenu(patients), done: false };
    }

    await ensureAccount(phone);
    let session = await getFSSession(phone);
    session.module = 'name_input';
    let patients = await listPatients(phone);

    if (session.state === 'INIT') {
      if (patients.length === 0) {
        session.state = 'ADD_NAME';
        session.temp = {};
        await saveFSSession(session);
        return { text:'首次使用：請輸入個人資料。\n\n1️⃣ 請輸入姓名（身份證姓名）。\n0️⃣ 返回上一題', done:false };
      } else {
        session.state = 'MENU';
        await saveFSSession(session);
        return { text: renderMenu(patients), done:false };
      }
    }

    switch (session.state) {
      case 'MENU': {
        if (isBackKey(body)) {
          // MENU 無上一題：停留本畫面
          return { text: renderMenu(patients, patients.length===0), done:false };
        }
        const n = Number(body);
        if (patients.length === 0) {
          session.state = 'ADD_NAME';
          session.temp = {};
          await saveFSSession(session);
          return { text:'首次使用：請輸入個人資料。\n\n1️⃣ 請輸入姓名（身份證姓名）。\n0️⃣ 返回上一題', done:false };
        }
        if (Number.isInteger(n) && n >= 1 && n <= patients.length + 1) {
          if (n <= patients.length) {
            const chosen = patients[n - 1];
            // 把選定病人寫回 index 的 sessions（selectedPatient）
            await db.collection('sessions').doc(phone).set({
              selectedPatient: { patientId: chosen.id, name: chosen.name }
            }, { merge:true });
            // 回兩段合併在一則訊息內：個資 + 下一步/更改
            const text =
              `${renderProfile(chosen)}\n\n` +
              '請確認下一步動作：\n' +
              '1️⃣ 進入下一步\n' +
              '2️⃣ 更改此病人資料\n' +
              '0️⃣ 返回上一題';
            session.state = 'AFTER_PICK';
            session.temp = { pickedId: chosen.id };
            await saveFSSession(session);
            return { text, done:false };
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
            return { text:'1️⃣ 請輸入姓名（身份證姓名）。\n0️⃣ 返回上一題', done:false };
          }
        }
        await saveFSSession(session);
        return { text: renderMenu(patients), done:false };
      }

      case 'AFTER_PICK': {
        if (isBackKey(body)) {
          session.state = 'MENU';
          await saveFSSession(session);
          return { text: renderMenu(patients), done:false };
        }
        if (body === '1') {
          return { text: '✅ 已確認，進入下一步。', done:true };
        }
        if (body === '2') {
          // 🆕 進入逐題顯示原值的更改流程
          const pid = session.temp?.pickedId;
          const current = pid ? await getPatient(phone, pid) : null;
          if (!current) {
            session.state = 'MENU';
            await saveFSSession(session);
            return { text:'未能讀取病人資料，請重新選擇。', done:false };
          }
          session.state = 'EDIT_NAME';
          session.temp = {
            pickedId: pid,
            editOrig: {
              name: current.name || '',
              gender: current.gender || '',
              birthDate: current.birthDate || '',
              idNumber: current.idNumber || ''
            },
            editNew: {}
          };
          await saveFSSession(session);
          return { text: renderEditPrompt('name', current.name), done:false };
        }
        return { text:'請輸入 1（下一步）或 2（更改），或 0 返回上一題。', done:false };
      }

      /** 🆕 逐題顯示原值的更改流程 **/
      case 'EDIT_NAME': {
        if (isBackKey(body)) {
          session.state = 'AFTER_PICK';
          await saveFSSession(session);
          return { text:'已返回。請輸入 1（進入下一步）或 2（更改此病人資料），或 0 返回上一題。', done:false };
        }
        const val = (body === '1') ? session.temp.editOrig.name : body;
        if (!val || val.trim().length === 0) {
          return { text:'姓名不能為空。請重新輸入。\n' + renderEditPrompt('name', session.temp.editOrig.name), done:false };
        }
        session.temp.editNew.name = val.trim();
        session.state = 'EDIT_GENDER';
        await saveFSSession(session);
        return { text: renderEditPrompt('gender', session.temp.editOrig.gender), done:false };
      }
      case 'EDIT_GENDER': {
        if (isBackKey(body)) {
          session.state = 'EDIT_NAME';
          await saveFSSession(session);
          return { text: renderEditPrompt('name', session.temp.editOrig.name), done:false };
        }
        const val = (body === '1') ? session.temp.editOrig.gender : body;
        if (!isValidGender(val)) {
          return { text:'格式不正確。請回覆「男」或「女」。\n' + renderEditPrompt('gender', session.temp.editOrig.gender), done:false };
        }
        session.temp.editNew.gender = val;
        session.state = 'EDIT_DOB';
        await saveFSSession(session);
        return { text: renderEditPrompt('birthDate', session.temp.editOrig.birthDate), done:false };
      }
      case 'EDIT_DOB': {
        if (isBackKey(body)) {
          session.state = 'EDIT_GENDER';
          await saveFSSession(session);
          return { text: renderEditPrompt('gender', session.temp.editOrig.gender), done:false };
        }
        const val = (body === '1') ? session.temp.editOrig.birthDate : body;
        if (!isValidDateYYYYMMDD(val)) {
          return { text:'出生日期格式不正確。請用 YYYY-MM-DD（例如：1978-01-21）。\n' + renderEditPrompt('birthDate', session.temp.editOrig.birthDate), done:false };
        }
        session.temp.editNew.birthDate = val;
        session.state = 'EDIT_ID';
        await saveFSSession(session);
        return { text: renderEditPrompt('idNumber', session.temp.editOrig.idNumber), done:false };
      }
      case 'EDIT_ID': {
        if (isBackKey(body)) {
          session.state = 'EDIT_DOB';
          await saveFSSession(session);
          return { text: renderEditPrompt('birthDate', session.temp.editOrig.birthDate), done:false };
        }
        const val = (body === '1') ? session.temp.editOrig.idNumber : body;
        if (!isValidId(val)) {
          return { text:'身份證號碼不正確，請重新輸入（至少 4 個字元）。\n' + renderEditPrompt('idNumber', session.temp.editOrig.idNumber), done:false };
        }
        session.temp.editNew.idNumber = val;

        // 寫回 Firestore
        const updates = {
          name: session.temp.editNew.name,
          gender: session.temp.editNew.gender,
          birthDate: session.temp.editNew.birthDate,
          idNumber: session.temp.editNew.idNumber
        };
        await updatePatient(phone, session.temp.pickedId, updates);

        // 讀回最新資料供顯示
        const updated = await getPatient(phone, session.temp.pickedId);

        // 設為選定病人（保持原行為）
        await db.collection('sessions').doc(phone).set({
          selectedPatient: { patientId: updated.id, name: updated.name }
        }, { merge:true });

        // 返回 AFTER_PICK：讓使用者可進入下一步或再次更改
        session.state = 'AFTER_PICK';
        session.temp = { pickedId: updated.id };
        await saveFSSession(session);

        const text = `${renderProfile(updated)}\n\n請確認下一步動作：\n1️⃣ 進入下一步\n2️⃣ 更改此病人資料\n0️⃣ 返回上一題`;
        return { text, done:false };
      }

      // === 以下為原本新增流程（不變） ===
      case 'ADD_NAME': {
        if (isBackKey(body)) {
          session.state = 'MENU';
          await saveFSSession(session);
          return { text: renderMenu(patients, patients.length===0), done:false };
        }
        if (!body) return { text:'請輸入有效的姓名（身份證姓名）。\n0️⃣ 返回上一題', done:false };
        session.temp.name = body;
        session.state = 'ADD_GENDER';
        await saveFSSession(session);
        return { text:'2️⃣ 請輸入性別（回覆「男」或「女」）。\n0️⃣ 返回上一題', done:false };
      }

      case 'ADD_GENDER': {
        if (isBackKey(body)) {
          session.state = 'ADD_NAME';
          await saveFSSession(session);
          return { text:'1️⃣ 請輸入姓名（身份證姓名）。\n0️⃣ 返回上一題', done:false };
        }
        if (!isValidGender(body)) return { text:'格式不正確。請回覆「男」或「女」。\n0️⃣ 返回上一題', done:false };
        session.temp.gender = body;
        session.state = 'ADD_DOB';
        await saveFSSession(session);
        return { text:'3️⃣ 請輸入出生日期（YYYY-MM-DD，例如：1978-01-21）。\n0️⃣ 返回上一題', done:false };
      }

      case 'ADD_DOB': {
        if (isBackKey(body)) {
          session.state = 'ADD_GENDER';
          await saveFSSession(session);
          return { text:'2️⃣ 請輸入性別（回覆「男」或「女」）。\n0️⃣ 返回上一題', done:false };
        }
        if (!isValidDateYYYYMMDD(body)) return { text:'出生日期格式不正確。請用 YYYY-MM-DD（例如：1978-01-21）。\n0️⃣ 返回上一題', done:false };
        session.temp.birthDate = body;
        session.state = 'ADD_ID';
        await saveFSSession(session);
        return { text:'4️⃣ 請輸入身份證號碼：\n0️⃣ 返回上一題', done:false };
      }

      case 'ADD_ID': {
        if (isBackKey(body)) {
          session.state = 'ADD_DOB';
          await saveFSSession(session);
          return { text:'3️⃣ 請輸入出生日期（YYYY-MM-DD，例如：1978-01-21）。\n0️⃣ 返回上一題', done:false };
        }
        if (!isValidId(body)) return { text:'身份證號碼不正確，請重新輸入（至少 4 個字元）。\n0️⃣ 返回上一題', done:false };

        patients = await listPatients(phone);
        if (patients.length >= 8) {
          session.state = 'DELETE_MENU';
          await saveFSSession(session);
          return { text:'⚠️ 已達 8 人上限，無法新增。\n\n' + renderDeleteMenu(patients), done:false };
        }

        session.temp.idNumber = body;
        const created = await addPatient(phone, session.temp);

        // 設為選定病人
        await db.collection('sessions').doc(phone).set({
          selectedPatient: { patientId: created.id, name: created.name }
        }, { merge:true });

        session.state = 'AFTER_PICK';
        session.temp = { pickedId: created.id };
        await saveFSSession(session);

        const text = `${renderProfile(created)}\n\n請確認下一步動作：\n1️⃣ 進入下一步\n2️⃣ 更改此病人資料\n0️⃣ 返回上一題`;
        return { text, done:false };
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