// modules/name_input.js
// Version: v6.0.4-fs
// 變更摘要：
// - 加入 REVIEW 確認頁：新增與更改在寫 DB 前，先顯示四項資料讓使用者確認
// - MENU 選舊病人：先 CONFIRM_PATIENT（1=更改 2=下一步 0=返回）
// - 更改流程走 ADD_NAME→ADD_GENDER→ADD_DOB→ADD_ID→REVIEW→(update)
// - 新增流程走 ADD_NAME→ADD_GENDER→ADD_DOB→ADD_ID→REVIEW→(add)
// - 回傳介面：{ texts?: string[], text?: string, done: boolean, meta?: any }；模組不直接回 Twilio
// - 首次進入（msg==''）只回第一題/選單，done:false

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
function renderTempSummary(temp){
  return [
    '📄 請確認以下資料：',
    `姓名：${temp.name || '－'}`,
    `性別：${temp.gender || '－'}`,
    `出生日期：${temp.birthDate || '－'}`,
    `身份證號碼：${temp.idNumber || '－'}`
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
async function updatePatient(phone, id, data){
  const ref = db.collection('users').doc(phone).collection('patients').doc(id);
  const payload = {
    name: data.name,
    gender: data.gender,
    birthDate: data.birthDate,
    idNumber: data.idNumber,
    updatedAt: new Date()
  };
  await ref.set(payload, { merge: true });
  const snap = await ref.get();
  return { id: ref.id, ...snap.data() };
}
async function deletePatient(phone, id){
  await db.collection('users').doc(phone).collection('patients').doc(id).delete();
}

// ---- Session（僅此模組用）----
// state: INIT | MENU | CONFIRM_PATIENT | ADD_NAME | ADD_GENDER | ADD_DOB | ADD_ID | REVIEW | DELETE_MENU
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

  const wrap = (textOrArr, done=false, meta) => {
    if (Array.isArray(textOrArr)) return { texts: textOrArr, done, meta };
    return { text: textOrArr, done, meta };
  };

  if (!phone) return wrap('系統未能識別你的電話號碼，請透過 WhatsApp 連結重新進入。', false);

  try {
    // ★ 首次進入：msg 空時絕不 done:true
    if (!body) {
      await ensureAccount(phone);
      let session = await getFSSession(phone);
      let patients = await listPatients(phone);

      if (session.state === 'INIT' || patients.length === 0) {
        session.state = 'ADD_NAME';
        session.temp = { mode: 'create', editingId: null, old:null };
        await saveFSSession(session);
        return wrap([
          '👉 第 1 步：輸入病人名字模組',
          '1️⃣ 請輸入姓名（身份證姓名）。',
          '（輸入 0 回上一頁）'
        ], false);
      }
      session.state = 'MENU';
      await saveFSSession(session);
      return wrap(renderMenu(patients), false);
    }

    await ensureAccount(phone);
    let session = await getFSSession(phone);
    session.module = 'name_input';
    let patients = await listPatients(phone);

    // INIT
    if (session.state === 'INIT') {
      if (patients.length === 0) {
        session.state = 'ADD_NAME';
        session.temp = { mode: 'create', editingId: null, old:null };
        await saveFSSession(session);
        return wrap('首次使用：請輸入個人資料。\n\n1️⃣ 請輸入姓名（身份證姓名）。\n（輸入 0 回上一頁）', false);
      } else {
        session.state = 'MENU';
        await saveFSSession(session);
        return wrap(renderMenu(patients), false);
      }
    }

    switch (session.state) {
      case 'MENU': {
        const n = Number(body);
        if (patients.length === 0) {
          session.state = 'ADD_NAME';
          session.temp = { mode: 'create', editingId: null, old:null };
          await saveFSSession(session);
          return wrap('1️⃣ 請輸入姓名（身份證姓名）。\n（輸入 0 回上一頁）', false);
        }
        if (Number.isInteger(n) && n >= 1 && n <= patients.length + 1) {
          if (n <= patients.length) {
            const chosen = patients[n - 1];
            // 進入確認既有病人
            session.state = 'CONFIRM_PATIENT';
            session.temp = { selected: chosen, mode: 'confirm', editingId: null, old:null };
            await saveFSSession(session);
            return wrap([
              renderProfile(chosen),
              '',
              '是否需要更改？',
              '1️⃣ 需要更改',
              '2️⃣ 不需要，進入下一步',
              '0️⃣ 返回選單'
            ], false);
          }
          if (n === patients.length + 1) {
            if (patients.length >= 8) {
              session.state = 'DELETE_MENU';
              await saveFSSession(session);
              return wrap('⚠️ 已達 8 人上限，無法新增。\n\n' + renderDeleteMenu(patients), false);
            }
            session.state = 'ADD_NAME';
            session.temp = { mode:'create', editingId:null, old:null };
            await saveFSSession(session);
            return wrap('1️⃣ 請輸入姓名（身份證姓名）。\n（輸入 0 回上一頁）', false);
          }
        }
        await saveFSSession(session);
        return wrap(renderMenu(patients), false);
      }

      case 'CONFIRM_PATIENT': {
        const v = (body || '').trim();
        if (v === '0') {
          session.state = 'MENU';
          session.temp = {};
          await saveFSSession(session);
          return wrap(renderMenu(patients), false);
        }
        if (v === '1') {
          const sel = session.temp.selected;
          session.state = 'ADD_NAME';
          session.temp = {
            mode:'edit',
            editingId: sel?.id || null,
            old: {
              name: sel?.name || '',
              gender: sel?.gender || '',
              birthDate: sel?.birthDate || '',
              idNumber: sel?.idNumber || ''
            }
          };
          await saveFSSession(session);
          return wrap(
            `1️⃣ 請輸入姓名（身份證姓名）。\n（原：${session.temp.old.name || '－'}）\n（輸入 0 回上一頁）`,
            false
          );
        }
        if (v === '2') {
          const sel = session.temp.selected;
          return wrap('✅ 已確認，將進入下一步。', true, {
            phone, patientId: sel?.id, name: sel?.name
          });
        }
        return wrap('請輸入 1（更改）/ 2（下一步）/ 0（返回選單）', false);
      }

      case 'ADD_NAME': {
        if (isBackKey(body)) {
          session.state = 'MENU';
          await saveFSSession(session);
          return wrap(renderMenu(patients, patients.length===0), false);
        }
        if (!body) return wrap('請輸入有效的姓名（身份證姓名）。\n（輸入 0 回上一頁）', false);
        session.temp.name = body;
        session.state = 'ADD_GENDER';
        await saveFSSession(session);
        const hint = session.temp.old?.gender ? `（原：${session.temp.old.gender}）\n` : '';
        return wrap(`2️⃣ 請輸入性別（回覆「男」或「女」）。\n${hint}（輸入 0 回上一頁）`, false);
      }

      case 'ADD_GENDER': {
        if (isBackKey(body)) {
          session.state = 'ADD_NAME';
          await saveFSSession(session);
          const hint = session.temp.old?.name ? `（原：${session.temp.old.name}）\n` : '';
          return wrap(`1️⃣ 請輸入姓名（身份證姓名）。\n${hint}（輸入 0 回上一頁）`, false);
        }
        if (!isValidGender(body)) return wrap('格式不正確。請回覆「男」或「女」。\n（輸入 0 回上一頁）', false);
        session.temp.gender = body;
        session.state = 'ADD_DOB';
        await saveFSSession(session);
        const hint = session.temp.old?.birthDate ? `（原：${session.temp.old.birthDate}）\n` : '';
        return wrap(`3️⃣ 請輸入出生日期（YYYY-MM-DD，例如：1978-01-21）。\n${hint}（輸入 0 回上一頁）`, false);
      }

      case 'ADD_DOB': {
        if (isBackKey(body)) {
          session.state = 'ADD_GENDER';
          await saveFSSession(session);
          const hint = session.temp.old?.gender ? `（原：${session.temp.old.gender}）\n` : '';
          return wrap(`2️⃣ 請輸入性別（回覆「男」或「女」）。\n${hint}（輸入 0 回上一頁）`, false);
        }
        if (!isValidDateYYYYMMDD(body)) return wrap('出生日期格式不正確。請用 YYYY-MM-DD（例如：1978-01-21）。\n（輸入 0 回上一頁）', false);
        session.temp.birthDate = body;
        session.state = 'ADD_ID';
        await saveFSSession(session);
        const hint = session.temp.old?.idNumber ? `（原：${session.temp.old.idNumber}）\n` : '';
        return wrap(`4️⃣ 請輸入身份證號碼：\n${hint}（輸入 0 回上一頁）`, false);
      }

      case 'ADD_ID': {
        if (isBackKey(body)) {
          session.state = 'ADD_DOB';
          await saveFSSession(session);
          const hint = session.temp.old?.birthDate ? `（原：${session.temp.old.birthDate}）\n` : '';
          return wrap(`3️⃣ 請輸入出生日期（YYYY-MM-DD，例如：1978-01-21）。\n${hint}（輸入 0 回上一頁）`, false);
        }
        if (!isValidId(body)) return wrap('身份證號碼不正確，請重新輸入（至少 4 個字元）。\n（輸入 0 回上一頁）', false);

        session.temp.idNumber = body;
        // 不立即寫 DB，先進 REVIEW 讓使用者確認
        session.state = 'REVIEW';
        await saveFSSession(session);
        return wrap([
          renderTempSummary(session.temp),
          '',
          '請確認以上資料是否正確？',
          '1️⃣ 正確，儲存並進入下一步',
          '2️⃣ 需要更改（回到姓名）',
          '0️⃣ 返回選單（放棄）'
        ], false);
      }

      case 'REVIEW': {
        const v = (body || '').trim();
        if (v === '0') {
          // 放棄，回主選單
          session.state = 'MENU';
          session.temp = {};
          await saveFSSession(session);
          return wrap(renderMenu(patients), false);
        }
        if (v === '2') {
          // 回姓名重填（保留當前 temp 值作提示）
          session.state = 'ADD_NAME';
          await saveFSSession(session);
          const hint = session.temp?.name ? `（原：${session.temp.name}）\n` : '';
          return wrap(`1️⃣ 請輸入姓名（身份證姓名）。\n${hint}（輸入 0 回上一頁）`, false);
        }
        if (v === '1') {
          // 寫 DB
          const isEditing = session.temp?.mode === 'edit' && !!session.temp.editingId;
          if (isEditing) {
            const updated = await updatePatient(phone, session.temp.editingId, {
              name: session.temp.name,
              gender: session.temp.gender,
              birthDate: session.temp.birthDate,
              idNumber: session.temp.idNumber
            });
            session.state = 'MENU';
            session.temp = {};
            await saveFSSession(session);
            return wrap([
              '💾 已更新。',
              '',
              renderProfile(updated),
              '',
              '✅ 已確認，將進入下一步。'
            ], true, { phone, patientId: updated.id, name: updated.name });
          } else {
            // 新增要先檢查名額
            const ps = await listPatients(phone);
            if (ps.length >= 8) {
              session.state = 'DELETE_MENU';
              await saveFSSession(session);
              return wrap('⚠️ 已達 8 人上限，無法新增。\n\n' + renderDeleteMenu(ps), false);
            }
            const created = await addPatient(phone, {
              name: session.temp.name,
              gender: session.temp.gender,
              birthDate: session.temp.birthDate,
              idNumber: session.temp.idNumber
            });
            session.state = 'MENU';
            session.temp = {};
            await saveFSSession(session);
            return wrap([
              '💾 已儲存。',
              '',
              renderProfile(created),
              '',
              '✅ 已選擇此病人，將進入下一步。'
            ], true, { phone, patientId: created.id, name: created.name });
          }
        }
        return wrap('請輸入：1=正確、2=需要更改、0=返回選單', false);
      }

      case 'DELETE_MENU': {
        if (isBackKey(body)) {
          session.state = 'MENU';
          await saveFSSession(session);
          return wrap(renderMenu(patients), false);
        }
        const n = Number(body);
        if (Number.isInteger(n) && n >=1 && n <= patients.length) {
          const target = patients[n-1];
          await deletePatient(phone, target.id);
          session.state = 'MENU';
          await saveFSSession(session);
          const after = await listPatients(phone);
          return wrap([`🗑️ 已刪除：${target.name}`, '', renderMenu(after)], false);
        }
        return wrap(renderDeleteMenu(patients), false);
      }

      default: {
        session.state = 'MENU';
        await saveFSSession(session);
        return wrap(renderMenu(patients, patients.length===0), false);
      }
    }
  } catch (err) {
    console.error('[name_input] error:', err?.stack || err);
    return wrap('系統暫時忙碌，請稍後再試。', false);
  }
}

module.exports = { handleNameInput };