// modules/name_input.js
// Version: v6.0.3-fs-edit+history-reset
// 變更摘要：
// - 顯示個資與選項合併為一則訊息（避免多則訊息分拆）。
// - 新增編輯既有病人流程（全欄位重填），最後「確認儲存」會 update 病人檔。
// - 確認儲存編輯後，會自動清空該病人的病史（刪除 history 與 history_sessions 的對應文件）。
// - 模組只回傳 { text, done }，不直接寫 Twilio response；與 index v6.4.x 對齊。
// - 模組內部 session 狀態存於 sessions/{phone} 的 name_input 子欄位（避免覆蓋其他模組/step）。
// - 使用者按 z 代表「進入下一步」→ 回 done:true；其他情境皆 done:false（等待輸入）。

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

const NI = { // name_input 狀態常數
  MENU: 'MENU',
  CONFIRM_EXISTING: 'CONFIRM_EXISTING',
  ADD_NAME: 'ADD_NAME',
  ADD_GENDER: 'ADD_GENDER',
  ADD_BIRTH: 'ADD_BIRTH',
  ADD_ID: 'ADD_ID',
  REVIEW_NEW: 'REVIEW_NEW',
  EDIT_NAME: 'EDIT_NAME',
  EDIT_GENDER: 'EDIT_GENDER',
  EDIT_BIRTH: 'EDIT_BIRTH',
  EDIT_ID: 'EDIT_ID',
  REVIEW_EDIT: 'REVIEW_EDIT'
};

const isZ = (s='') => s.trim().toLowerCase() === 'z';
const isBack = (s='') => s.trim() === '0';
function isValidGender(t){ return t === '男' || t === '女'; }
function isValidDateYYYYMMDD(t){
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const [y,m,d] = t.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, d));
  return dt.getUTCFullYear()===y && (dt.getUTCMonth()+1)===m && dt.getUTCDate()===d && y>=1900 && y<=2100;
}
function isValidId(t){ return typeof t === 'string' && t.trim().length >= 4; }
const nowTS = () => admin.firestore.FieldValue.serverTimestamp();

function renderProfileBlock(p){
  return [
    '📄 病人個人資料',
    `姓名：${p.name || ''}`,
    `性別：${p.gender || ''}`,
    `出生日期：${p.birthDate || ''}`,
    `身份證號碼：${p.idNumber || ''}`
  ].join('\n');
}
function renderChooseNext(){
  return [
    '',
    '請選擇：',
    '1️⃣ 更改資料（會重新填寫姓名、性別、出生日期、身份證）',
    'z️⃣ 進入下一步'
  ].join('\n');
}
function renderInvalid(){ return '⚠️ 輸入無效，請按畫面指示回覆。'; }

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
async function updatePatient(phone, patientId, patch){
  patch.updatedAt = new Date();
  await db.collection('users').doc(phone).collection('patients').doc(patientId)
    .set(patch, { merge:true });
}
async function resetHistory(phone, patientId){
  // 1) 若你的 history/history_sessions 使用「phone#patientId」作為 key，則同時清掉
  const key = `${phone}#${patientId}`;
  await db.collection('history').doc(key).delete().catch(()=>{});
  await db.collection('history_sessions').doc(key).delete().catch(()=>{});
  // 2) 如果你曾把病史塞在 patient doc 的欄位，也一併清除（保守處理）
  await db.collection('users').doc(phone).collection('patients').doc(patientId)
    .set({ history: admin.firestore.FieldValue.delete() }, { merge:true })
    .catch(()=>{});
}

async function getSessionDoc(phone){
  const ref = db.collection('sessions').doc(phone);
  const snap = await ref.get();
  if (!snap.exists) {
    const fresh = { step: 1, updatedAt: nowTS(), name_input: { state: NI.MENU } };
    await ref.set(fresh);
    return { ref, data: fresh };
  }
  return { ref, data: snap.data() || { name_input: { state: NI.MENU } } };
}
async function saveNI(phone, patchNI){
  const { ref } = await getSessionDoc(phone);
  await ref.set({ name_input: { ...patchNI }, updatedAt: nowTS() }, { merge:true });
}
async function setSelectedPatient(phone, { patientId, name }){
  const { ref, data } = await getSessionDoc(phone);
  await ref.set({
    selectedPatient: { patientId, name, updatedAt: nowTS() },
    updatedAt: nowTS()
  }, { merge:true });
}

// ---- 主處理器 ----
async function handleNameInput({ req, from, msg }) {
  const rawFrom = from || (req?.body?.From ?? '').toString();
  const phone = phoneOf(rawFrom);
  const body  = (msg ?? req?.body?.Body ?? '').toString().trim();

  if (!phone) return { text:'系統未能識別你的電話號碼，請透過 WhatsApp 連結重新進入。', done:false };

  await ensureAccount(phone);
  const { ref, data } = await getSessionDoc(phone);
  const ni = data.name_input || { state: NI.MENU, buffer:{}, selectedPatientId: '' };

  // 便利：即時抓目前病人清單
  const patients = await listPatients(phone);

  // --- 歡迎或第一次進入（沒有輸入時）→ 顯示清單或進新增 ---
  if (!body) {
    if (!patients.length) {
      await ref.set({ name_input: { state: NI.ADD_NAME, buffer:{} }, updatedAt: nowTS() }, { merge:true });
      return { text: '👉 第 1 步：輸入病人名字\n首次使用此電話號碼。\n\n1️⃣ 請輸入姓名（身份證姓名）。\n（輸入 0 回上一頁）', done:false };
    }
    const list = patients.map((p,i)=>`${i+1}. ${p.name}`).join('\n');
    await ref.set({ name_input: { state: NI.MENU }, updatedAt: nowTS() }, { merge:true });
    return { text: `👉 第 1 步：輸入病人名字\n請選擇病人或新增：\n${list}\n${patients.length+1}. ➕ 新增病人\n\n回覆編號（例如：1）。`, done:false };
  }

  // ---- 狀態機 ----
  switch (ni.state) {
    case NI.MENU: {
      const n = Number(body);
      if (Number.isInteger(n) && n >= 1 && n <= patients.length + 1) {
        // 選現有
        if (n <= patients.length) {
          const chosen = patients[n-1];
          await ref.set({
            name_input: { state: NI.CONFIRM_EXISTING, selectedPatientId: chosen.id, buffer:{} },
            updatedAt: nowTS()
          }, { merge:true });

          const text = [
            renderProfileBlock(chosen),
            renderChooseNext()
          ].join('\n');
          return { text, done:false };
        }
        // 新增
        if (n === patients.length + 1) {
          await ref.set({ name_input: { state: NI.ADD_NAME, buffer:{} }, updatedAt: nowTS() }, { merge:true });
          return { text:'1️⃣ 請輸入姓名（身份證姓名）。\n（輸入 0 回上一頁）', done:false };
        }
      }
      return { text: renderInvalid(), done:false };
    }

    case NI.CONFIRM_EXISTING: {
      if (isBack(body)) {
        await ref.set({ name_input: { state: NI.MENU, buffer:{} } , updatedAt: nowTS() }, { merge:true });
        const list = patients.map((p,i)=>`${i+1}. ${p.name}`).join('\n');
        return { text: `請選擇病人或新增：\n${list}\n${patients.length+1}. ➕ 新增病人`, done:false };
      }
      if (body === '1') {
        // 進入重填（編輯）流程
        await ref.set({ name_input: { state: NI.EDIT_NAME, buffer:{} }, updatedAt: nowTS() }, { merge:true });
        return { text: '✏️ 請輸入更新後的姓名：\n（輸入 0 返回）', done:false };
      }
      if (isZ(body)) {
        // 直接進下一步 → 設定 selectedPatient 給 index / history
        const chosen = patients.find(p=>p.id === ni.selectedPatientId);
        if (!chosen) return { text: '找不到所選病人，請返回選擇。', done:false };
        await setSelectedPatient(phone, { patientId: chosen.id, name: chosen.name });
        return { text: '✅ 病人確認，進入下一步。', done:true };
      }
      return { text: '請輸入 1 更改資料，或 z 進入下一步（0 返回）。', done:false };
    }

    // ---- 新增流程 ----
    case NI.ADD_NAME: {
      if (isBack(body)) {
        await ref.set({ name_input: { state: NI.MENU, buffer:{} }, updatedAt: nowTS() }, { merge:true });
        const list = patients.map((p,i)=>`${i+1}. ${p.name}`).join('\n');
        return { text: `請選擇病人或新增：\n${list}\n${patients.length+1}. ➕ 新增病人`, done:false };
      }
      const buf = { ...(ni.buffer||{}), name: body };
      await ref.set({ name_input: { state: NI.ADD_GENDER, buffer: buf }, updatedAt: nowTS() }, { merge:true });
      return { text: '2️⃣ 請輸入性別（回覆「男」或「女」）。\n（輸入 0 返回）', done:false };
    }

    case NI.ADD_GENDER: {
      if (isBack(body)) {
        await ref.set({ name_input: { state: NI.ADD_NAME, buffer: ni.buffer||{} }, updatedAt: nowTS() }, { merge:true });
        return { text: '1️⃣ 請輸入姓名（身份證姓名）。\n（輸入 0 返回）', done:false };
      }
      if (!isValidGender(body)) return { text: '格式不正確。請回覆「男」或「女」。\n（輸入 0 返回）', done:false };
      const buf = { ...(ni.buffer||{}), gender: body };
      await ref.set({ name_input: { state: NI.ADD_BIRTH, buffer: buf }, updatedAt: nowTS() }, { merge:true });
      return { text: '3️⃣ 請輸入出生日期（YYYY-MM-DD，例如：1978-01-21）。\n（輸入 0 返回）', done:false };
    }

    case NI.ADD_BIRTH: {
      if (isBack(body)) {
        await ref.set({ name_input: { state: NI.ADD_GENDER, buffer: ni.buffer||{} }, updatedAt: nowTS() }, { merge:true });
        return { text: '2️⃣ 請輸入性別（回覆「男」或「女」）。\n（輸入 0 返回）', done:false };
      }
      if (!isValidDateYYYYMMDD(body)) return { text: '出生日期格式不正確。請用 YYYY-MM-DD（例如：1978-01-21）。\n（輸入 0 返回）', done:false };
      const buf = { ...(ni.buffer||{}), birthDate: body };
      await ref.set({ name_input: { state: NI.ADD_ID, buffer: buf }, updatedAt: nowTS() }, { merge:true });
      return { text: '4️⃣ 請輸入身份證號碼：\n（輸入 0 返回）', done:false };
    }

    case NI.ADD_ID: {
      if (isBack(body)) {
        await ref.set({ name_input: { state: NI.ADD_BIRTH, buffer: ni.buffer||{} }, updatedAt: nowTS() }, { merge:true });
        return { text: '3️⃣ 請輸入出生日期（YYYY-MM-DD，例如：1978-01-21）。\n（輸入 0 返回）', done:false };
      }
      if (!isValidId(body)) return { text: '身份證號碼不正確，請重新輸入（至少 4 個字元）。\n（輸入 0 返回）', done:false };

      // 檢查名額
      const listNow = await listPatients(phone);
      if (listNow.length >= 8) {
        await ref.set({ name_input: { state: NI.MENU, buffer:{} }, updatedAt: nowTS() }, { merge:true });
        return { text: '⚠️ 已達 8 人上限，無法新增。請刪除後再試。', done:false };
      }

      const created = await addPatient(phone, { ...(ni.buffer||{}), idNumber: body });
      const review = [
        '💾 已暫存以下資料：',
        '',
        renderProfileBlock(created),
        '',
        '請確認是否儲存？',
        '1️⃣ 確認儲存',
        '0️⃣ 取消返回（不儲存）'
      ].join('\n');

      await ref.set({
        name_input: { state: NI.REVIEW_NEW, buffer: { ...created }, selectedPatientId: created.id },
        updatedAt: nowTS()
      }, { merge:true });

      return { text: review, done:false };
    }

    case NI.REVIEW_NEW: {
      if (body === '1') {
        const buf = ni.buffer || {};
        // 已在 ADD_ID addPatient 寫入；這邊只需設定 selectedPatient 給 index
        await setSelectedPatient(phone, { patientId: ni.selectedPatientId, name: buf.name || '' });

        const text = [
          '✅ 已儲存並選定此病人。',
          '',
          renderProfileBlock(buf),
          '',
          '請輸入 z 進入下一步；或輸入 1 重新編輯此病人資料。'
        ].join('\n');

        // 返回確認畫面（可選擇 z 繼續，或 1 再編輯）
        await ref.set({
          name_input: { state: NI.CONFIRM_EXISTING, buffer:{}, selectedPatientId: ni.selectedPatientId },
          updatedAt: nowTS()
        }, { merge:true });

        return { text, done:false };
      }
      if (isBack(body)) {
        // 取消不存，回到選單
        await ref.set({ name_input: { state: NI.MENU, buffer:{} }, updatedAt: nowTS() }, { merge:true });
        const list = patients.map((p,i)=>`${i+1}. ${p.name}`).join('\n');
        return { text: `已取消。\n\n請選擇病人或新增：\n${list}\n${patients.length+1}. ➕ 新增病人`, done:false };
      }
      return { text: '請輸入：1 確認儲存，或 0 取消返回。', done:false };
    }

    // ---- 編輯既有病人（重填四欄）----
    case NI.EDIT_NAME: {
      if (isBack(body)) {
        // 返回確認畫面
        const chosen = patients.find(p=>p.id === ni.selectedPatientId);
        await ref.set({ name_input: { state: NI.CONFIRM_EXISTING, buffer:{} }, updatedAt: nowTS() }, { merge:true });
        const text = [ renderProfileBlock(chosen || {}), renderChooseNext() ].join('\n');
        return { text, done:false };
      }
      const buf = { name: body };
      await ref.set({ name_input: { state: NI.EDIT_GENDER, buffer: buf, selectedPatientId: ni.selectedPatientId }, updatedAt: nowTS() }, { merge:true });
      return { text: '請輸入性別（男 / 女）：\n（輸入 0 返回）', done:false };
    }
    case NI.EDIT_GENDER: {
      if (isBack(body)) {
        await ref.set({ name_input: { state: NI.EDIT_NAME, buffer: ni.buffer||{}, selectedPatientId: ni.selectedPatientId }, updatedAt: nowTS() }, { merge:true });
        return { text: '請輸入更新後的姓名：\n（輸入 0 返回）', done:false };
      }
      if (!isValidGender(body)) return { text: '格式不正確。請回覆「男」或「女」。\n（輸入 0 返回）', done:false };
      const buf = { ...(ni.buffer||{}), gender: body };
      await ref.set({ name_input: { state: NI.EDIT_BIRTH, buffer: buf, selectedPatientId: ni.selectedPatientId }, updatedAt: nowTS() }, { merge:true });
      return { text: '請輸入出生日期（YYYY-MM-DD）：\n（輸入 0 返回）', done:false };
    }
    case NI.EDIT_BIRTH: {
      if (isBack(body)) {
        await ref.set({ name_input: { state: NI.EDIT_GENDER, buffer: ni.buffer||{}, selectedPatientId: ni.selectedPatientId }, updatedAt: nowTS() }, { merge:true });
        return { text: '請輸入性別（男 / 女）：\n（輸入 0 返回）', done:false };
      }
      if (!isValidDateYYYYMMDD(body)) return { text: '出生日期格式不正確。請用 YYYY-MM-DD（例如：1978-01-21）。\n（輸入 0 返回）', done:false };
      const buf = { ...(ni.buffer||{}), birthDate: body };
      await ref.set({ name_input: { state: NI.EDIT_ID, buffer: buf, selectedPatientId: ni.selectedPatientId }, updatedAt: nowTS() }, { merge:true });
      return { text: '請輸入身份證號碼：\n（輸入 0 返回）', done:false };
    }
    case NI.EDIT_ID: {
      if (isBack(body)) {
        await ref.set({ name_input: { state: NI.EDIT_BIRTH, buffer: ni.buffer||{}, selectedPatientId: ni.selectedPatientId }, updatedAt: nowTS() }, { merge:true });
        return { text: '請輸入出生日期（YYYY-MM-DD）：\n（輸入 0 返回）', done:false };
      }
      if (!isValidId(body)) return { text: '身份證號碼不正確，請重新輸入（至少 4 個字元）。\n（輸入 0 返回）', done:false };

      const preview = {
        name: (ni.buffer||{}).name,
        gender: (ni.buffer||{}).gender,
        birthDate: (ni.buffer||{}).birthDate,
        idNumber: body
      };
      await ref.set({ name_input: { state: NI.REVIEW_EDIT, buffer: preview, selectedPatientId: ni.selectedPatientId }, updatedAt: nowTS() }, { merge:true });

      const text = [
        '請確認以下更新內容：',
        '',
        renderProfileBlock(preview),
        '',
        '1️⃣ 確認儲存（將清空此病人的舊病史）',
        '0️⃣ 取消（返回上一頁）'
      ].join('\n');

      return { text, done:false };
    }
    case NI.REVIEW_EDIT: {
      if (body === '1') {
        const pid = ni.selectedPatientId;
        const buf = ni.buffer || {};
        // 1) 更新 profile
        await updatePatient(phone, pid, {
          name: buf.name, gender: buf.gender, birthDate: buf.birthDate, idNumber: buf.idNumber
        });
        // 2) 清空病史（history + history_sessions）
        await resetHistory(phone, pid);
        // 3) 設定 selectedPatient 給下一步
        await setSelectedPatient(phone, { patientId: pid, name: buf.name || '' });

        const chosenText = [
          '✅ 已更新病人資料，並清空舊有病史。',
          '',
          renderProfileBlock(buf),
          '',
          '請輸入 z 進入下一步；或輸入 1 再次更改。'
        ].join('\n');

        // 返回確認畫面狀態（等待使用者 z 或 1）
        await ref.set({ name_input: { state: NI.CONFIRM_EXISTING, buffer:{}, selectedPatientId: pid }, updatedAt: nowTS() }, { merge:true });

        return { text: chosenText, done:false };
      }
      if (isBack(body)) {
        // 返回上一頁（再輸入身份證）
        await ref.set({ name_input: { state: NI.EDIT_ID, buffer: ni.buffer||{}, selectedPatientId: ni.selectedPatientId }, updatedAt: nowTS() }, { merge:true });
        return { text: '請輸入身份證號碼：\n（輸入 0 返回）', done:false };
      }
      return { text: '請輸入 1 確認儲存，或 0 取消返回。', done:false };
    }

    default:
      // 不認得狀態 → 回主選單
      await ref.set({ name_input: { state: NI.MENU, buffer:{} }, updatedAt: nowTS() }, { merge:true });
      const list = patients.map((p,i)=>`${i+1}. ${p.name}`).join('\n');
      return { text: `👉 第 1 步：輸入病人名字\n請選擇病人或新增：\n${list}\n${patients.length+1}. ➕ 新增病人\n\n回覆編號（例如：1）。`, done:false };
  }
}

module.exports = { handleNameInput };