/**
 * File: modules/history.js
 * Version: v6.2.0-fs-composite
 * Interface: async handleHistory({ msg, from, patientId, patientName }) -> { text, done }
 *
 * 特性：
 * - 以複合鍵（phone__patientId）存 history 與 history_sessions，確保每位病人唯一。
 * - 所有訊息頂部顯示「病人：<name>（<phone末4>）」。
 * - DONE 畫面支援：1＝重新修改、z＝完成（回傳 done:true 讓 index 進下一步）。
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
const nowTS = () => admin.firestore.FieldValue.serverTimestamp();

const STATES = {
  ENTRY: 'H_ENTRY',
  SHOW_EXISTING: 'H_SHOW',
  FIRST_NOTICE: 'H_FIRST',
  PMH_SELECT: 'H_PMH',
  PMH_OTHER_INPUT: 'H_PMH_OTHER',
  MEDS_YN: 'H_MEDS_YN',
  MEDS_INPUT: 'H_MEDS_IN',
  ALLERGY_YN: 'H_ALG_YN',
  ALLERGY_TYPE: 'H_ALG_T',
  ALLERGY_INPUT: 'H_ALG_IN',
  SOCIAL_SMOKE: 'H_SOC_SMK',
  SOCIAL_ALCOHOL: 'H_SOC_ALC',
  SOCIAL_TRAVEL: 'H_SOC_TRV',
  REVIEW: 'H_REVIEW',
  DONE: 'H_DONE'
};

const PMH_OPTIONS = ['高血壓','糖尿病','心臟病','腎臟病','肝病','中風','癌症','其他','無'];
const YES = '1', NO = '2';

const phoneKey = (from) =>
  (from || '').toString().replace(/^whatsapp:/i, '').trim() || 'DEFAULT';
const last4 = (phone) => (phone || '').replace(/\D/g,'').slice(-4) || '----';
const isZ = (v='') => /^z$/i.test(v.trim());
const isOne = (v='') => v.trim() === '1';
const isYesNo = (v) => v === YES || v === NO;

const header = (name, phone) => `【病人：${name || '未命名'}（${last4(phone)}）】`;

function initHistory(){
  return { pmh: [], meds: [], allergies: { types: [], items: [] }, social: { smoking:'', alcohol:'', travel:'' } };
}
function renderPMHMenu(){
  return '請選擇您曾經患有的疾病（可複選，用逗號分隔數字）：\n' +
    PMH_OPTIONS.map((t,i)=>`${i+1}️⃣ ${t}`).join('\n');
}
function commaNumListToIndices(text) {
  return String(text || '')
    .replace(/，/g, ',')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(n => parseInt(n, 10))
    .filter(n => !Number.isNaN(n));
}
function renderSummary(h){
  const pmh      = h.pmh?.length ? h.pmh.join('、') : '無';
  const meds     = h.meds?.length ? h.meds.join('、') : '無';
  const alTypes  = h.allergies?.types?.length ? h.allergies.types.join('、') : '無';
  const alItems  = h.allergies?.items?.length ? h.allergies.items.join('、') : '無';
  const smoking  = h.social?.smoking || '未填';
  const alcohol  = h.social?.alcohol || '未填';
  const travel   = h.social?.travel  || '未填';
  return [
    `- 過去病史：${pmh}`,
    `- 服用藥物：${meds}`,
    `- 過敏類型：${alTypes}`,
    `- 過敏明細：${alItems}`,
    `- 吸菸：${smoking}；飲酒：${alcohol}；近期出國：${travel}`
  ].join('\n');
}
function reviewText(h, name, phone){
  return `${header(name, phone)}\n感謝您提供病史資料 🙏\n以下是您剛填寫的內容：\n${renderSummary(h)}\n\n請問需要更改嗎？\n1️⃣ 需要更改\nz️⃣ 進入下一步`;
}

// --- Firestore I/O（用複合鍵）---
function keyOf(phone, patientId){ return `${phone}__${patientId}`; }
async function getSession(historyKey){
  const ref = db.collection('history_sessions').doc(historyKey);
  const s = await ref.get();
  if (s.exists) return s.data();
  const fresh = { state: STATES.ENTRY, buffer: {}, updatedAt: nowTS() };
  await ref.set(fresh);
  return fresh;
}
async function saveSession(historyKey, patch){
  await db.collection('history_sessions').doc(historyKey)
    .set({ ...patch, updatedAt: nowTS() }, { merge: true });
}
async function getHistory(historyKey){
  const ref = db.collection('history').doc(historyKey);
  const s = await ref.get();
  return s.exists ? (s.data()?.history || null) : null;
}
async function saveHistory(historyKey, historyObj){
  await db.collection('history').doc(historyKey)
    .set({ history: historyObj, updatedAt: nowTS() }, { merge: true });
}

// --- 主處理器 ---
module.exports.handleHistory = async function handleHistory({ msg, from, patientId, patientName }) {
  const phone = phoneKey(from);
  const body  = (msg || '').trim();

  if (!patientId) {
    return { text: '⚠️ 未取得病人代號（patientId）。請回到第 1 步選擇病人後再試。', done: false };
  }

  const hKey = keyOf(phone, patientId);
  let session = await getSession(hKey);
  let history = await getHistory(hKey);

  // 入口
  if (session.state === STATES.ENTRY) {
    if (history) {
      session.state = STATES.SHOW_EXISTING;
      await saveSession(hKey, { state: session.state });
      return {
        text:
`${header(patientName, phone)}
👉 第 4 步：讀取病人病史模組

已找到你之前輸入的病史資料：
${renderSummary(history)}

是否需要更改？
1️⃣ 需要更改
z️⃣ 進入下一步`,
        done: false
      };
    }
    session.state = STATES.FIRST_NOTICE;
    await saveSession(hKey, { state: session.state });
    return {
      text:
`${header(patientName, phone)}
👉 第 4 步：讀取病人病史模組

首次使用此病人資料，我們會收集基本病史（約 2–3 分鐘）。

請按 z 開始。`,
      done: false
    };
  }

  // 舊資料確認
  if (session.state === STATES.SHOW_EXISTING) {
    if (isOne(body)) {
      session.state = STATES.PMH_SELECT;
      session.buffer = { history: initHistory() };
      await saveSession(hKey, { state: session.state, buffer: session.buffer });
      return { text: `${header(patientName, phone)}\n${renderPMHMenu()}`, done: false };
    }
    if (isZ(body)) {
      session.state = STATES.DONE;
      await saveSession(hKey, { state: session.state });
      return { text: `${header(patientName, phone)}\n✅ 病史已確認無需更改，將進入下一步。`, done: true };
    }
    return { text: `${header(patientName, phone)}\n請回覆：1＝需要更改，或 z＝進入下一步。`, done: false };
  }

  // 首次說明 → 開始
  if (session.state === STATES.FIRST_NOTICE) {
    if (!isZ(body)) return { text: `${header(patientName, phone)}\n請按 z 開始。`, done: false };
    session.state = STATES.PMH_SELECT;
    session.buffer = { history: initHistory() };
    await saveSession(hKey, { state: session.state, buffer: session.buffer });
    return { text: `${header(patientName, phone)}\n${renderPMHMenu()}`, done: false };
  }

  // PMH
  if (session.state === STATES.PMH_SELECT) {
    const idxs = commaNumListToIndices(body);
    if (!idxs.length || !idxs.every(n=>n>=1 && n<=PMH_OPTIONS.length)) {
      return { text: `${header(patientName, phone)}\n格式不正確，請用逗號分隔數字，例如：1,2 或 1,3,7\n\n${renderPMHMenu()}`, done: false };
    }
    const names = [];
    let needOther = false, isNone = false;
    for (const n of idxs) {
      if (n === 8) needOther = true;
      if (n === 9) isNone = true;
      names.push(PMH_OPTIONS[n-1]);
    }
    if (isNone) session.buffer.history.pmh = [];
    else session.buffer.history.pmh = names.filter(x => x!=='其他' && x!=='無');

    if (needOther && !isNone) {
      session.state = STATES.PMH_OTHER_INPUT;
      await saveSession(hKey, { state: session.state, buffer: session.buffer });
      return { text: `${header(patientName, phone)}\n請輸入「其他」的具體病名（可多個，以逗號或頓號分隔）`, done: false };
    }
    session.state = STATES.MEDS_YN;
    await saveSession(hKey, { state: session.state, buffer: session.buffer });
    return { text: `${header(patientName, phone)}\n您目前是否有在服用藥物？\n1️⃣ 有\n2️⃣ 沒有`, done: false };
  }

  if (session.state === STATES.PMH_OTHER_INPUT) {
    const extra = body.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
    session.buffer.history.pmh.push(...extra);
    session.state = STATES.MEDS_YN;
    await saveSession(hKey, { state: session.state, buffer: session.buffer });
    return { text: `${header(patientName, phone)}\n您目前是否有在服用藥物？\n1️⃣ 有\n2️⃣ 沒有`, done: false };
  }

  // 用藥
  if (session.state === STATES.MEDS_YN) {
    if (!isYesNo(body)) return { text: `${header(patientName, phone)}\n請輸入 1️⃣ 有 或 2️⃣ 沒有`, done: false };
    if (body === YES) {
      session.state = STATES.MEDS_INPUT;
      await saveSession(hKey, { state: session.state, buffer: session.buffer });
      return { text: `${header(patientName, phone)}\n請輸入正在服用的藥物名稱（可多個，以逗號或頓號分隔）`, done: false };
    }
    session.buffer.history.meds = [];
    session.state = STATES.ALLERGY_YN;
    await saveSession(hKey, { state: session.state, buffer: session.buffer });
    return { text: `${header(patientName, phone)}\n是否有藥物或食物過敏？\n1️⃣ 有\n2️⃣ 無`, done: false };
  }

  if (session.state === STATES.MEDS_INPUT) {
    const meds = body.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
    session.buffer.history.meds = meds;
    session.state = STATES.ALLERGY_YN;
    await saveSession(hKey, { state: session.state, buffer: session.buffer });
    return { text: `${header(patientName, phone)}\n是否有藥物或食物過敏？\n1️⃣ 有\n2️⃣ 無`, done: false };
  }

  // 過敏
  if (session.state === STATES.ALLERGY_YN) {
    if (!isYesNo(body)) return { text: `${header(patientName, phone)}\n請輸入 1️⃣ 有 或 2️⃣ 無`, done: false };
    if (body === YES) {
      session.state = STATES.ALLERGY_TYPE;
      session.buffer.history.allergies = { types: [], items: [] };
      await saveSession(hKey, { state: session.state, buffer: session.buffer });
      return { text: `${header(patientName, phone)}\n過敏類型（可複選，用逗號分隔）：\n1️⃣ 藥物\n2️⃣ 食物\n3️⃣ 其他`, done: false };
    }
    session.buffer.history.allergies = { types: [], items: [] };
    session.state = STATES.SOCIAL_SMOKE;
    await saveSession(hKey, { state: session.state, buffer: session.buffer });
    return { text: `${header(patientName, phone)}\n吸菸情況：\n1️⃣ 有\n2️⃣ 無\n（若已戒可輸入：已戒）`, done: false };
  }

  if (session.state === STATES.ALLERGY_TYPE) {
    const idxs = commaNumListToIndices(body);
    if (!idxs.length || !idxs.every(n=>n>=1 && n<=3)) {
      return { text: `${header(patientName, phone)}\n請以逗號分隔數字，例如：1,2（1=藥物 2=食物 3=其他）`, done: false };
    }
    const map = {1:'藥物',2:'食物',3:'其他'};
    session.buffer.history.allergies.types = [...new Set(idxs.map(n=>map[n]))];
    session.state = STATES.ALLERGY_INPUT;
    await saveSession(hKey, { state: session.state, buffer: session.buffer });
    return { text: `${header(patientName, phone)}\n請輸入過敏項目（例如：青黴素、花生…；可多個，用逗號或頓號分隔）`, done: false };
  }

  if (session.state === STATES.ALLERGY_INPUT) {
    const items = body.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
    session.buffer.history.allergies.items = items;
    session.state = STATES.SOCIAL_SMOKE;
    await saveSession(hKey, { state: session.state, buffer: session.buffer });
    return { text: `${header(patientName, phone)}\n吸菸情況：\n1️⃣ 有\n2️⃣ 無\n（若已戒可輸入：已戒）`, done: false };
  }

  // 社會史
  if (session.state === STATES.SOCIAL_SMOKE) {
    const v = body.trim();
    let smoking='';
    if (v===YES) smoking='有';
    else if (v===NO) smoking='無';
    else if (v==='已戒') smoking='已戒';
    else return { text: `${header(patientName, phone)}\n請輸入 1️⃣ 有、2️⃣ 無，或輸入「已戒」`, done: false };
    session.buffer.history.social.smoking = smoking;
    session.state = STATES.SOCIAL_ALCOHOL;
    await saveSession(hKey, { state: session.state, buffer: session.buffer });
    return { text: `${header(patientName, phone)}\n飲酒情況：\n1️⃣ 每天\n2️⃣ 偶爾\n（若不喝請輸入：無）`, done: false };
  }

  if (session.state === STATES.SOCIAL_ALCOHOL) {
    const v = body.trim();
    let alcohol='';
    if (v===YES) alcohol='每天';
    else if (v===NO) alcohol='偶爾';
    else if (v==='無') alcohol='無';
    else return { text: `${header(patientName, phone)}\n請輸入 1️⃣ 每天、2️⃣ 偶爾，或輸入「無」`, done: false };
    session.buffer.history.social.alcohol = alcohol;
    session.state = STATES.SOCIAL_TRAVEL;
    await saveSession(hKey, { state: session.state, buffer: session.buffer });
    return { text: `${header(patientName, phone)}\n最近三個月是否出國旅行？\n1️⃣ 有\n2️⃣ 無`, done: false };
  }

  if (session.state === STATES.SOCIAL_TRAVEL) {
    if (!isYesNo(body)) return { text: `${header(patientName, phone)}\n請輸入 1️⃣ 有 或 2️⃣ 無`, done: false };
    session.buffer.history.social.travel = (body===YES)?'有':'無';

    const latest = session.buffer.history;
    await saveHistory(hKey, latest);

    session.state = STATES.REVIEW;
    await saveSession(hKey, { state: session.state, buffer: session.buffer });
    return { text: reviewText(latest, patientName, phone), done: false };
  }

  // REVIEW
  if (session.state === STATES.REVIEW) {
    if (isOne(body)) {
      session.state = STATES.PMH_SELECT;
      session.buffer = { history: initHistory() };
      await saveSession(hKey, { state: session.state, buffer: session.buffer });
      return { text: `${header(patientName, phone)}\n${renderPMHMenu()}`, done: false };
    }
    if (isZ(body)) {
      session.state = STATES.DONE;
      await saveSession(hKey, { state: session.state });
      return { text: `${header(patientName, phone)}\n✅ 已儲存最新病史，將進入下一個模組。`, done: true };
    }
    return { text: `${header(patientName, phone)}\n請回覆：1＝需要更改，或 z＝進入下一步。`, done: false };
  }

  // DONE（支援 1 / z）
  if (session.state === STATES.DONE) {
    const t = body.toLowerCase();
    if (t === '1') {
      session.state  = STATES.PMH_SELECT;
      session.buffer = { history: initHistory() };
      await saveSession(hKey, { state: session.state, buffer: session.buffer });
      return { text: `${header(patientName, phone)}\n${renderPMHMenu()}`, done: false };
    }
    if (t === 'z') {
      return { text: `${header(patientName, phone)}\n✅ 病史模組已完成，進入下一步。`, done: true };
    }
    return {
      text: `${header(patientName, phone)}\n（提示）病史模組已完成。\n如需更改請回覆 1；否則按 z 進入下一步。`,
      done: false
    };
  }

  // 兜底
  session.state = STATES.ENTRY;
  session.buffer = {};
  await saveSession(hKey, { state: session.state, buffer: session.buffer });
  return { text: `${header(patientName, phone)}\n已重置病史模組，請重新開始。`, done: false };
};