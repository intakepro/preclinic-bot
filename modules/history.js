/**
 * Module: modules/history.js
 * Version: v6.0.0-firestore
 * 介面：async handleHistory({ msg, from }) -> { text: string, done: boolean }
 *
 * 說明：
 * - 配合 index v6.0.0：模組只回 { text, done }，不觸碰 res/twiml。
 * - Firestore 持久化（預設啟用）。支援兩個集合：
 *     - history/{userKey}         -> { history: {...}, updatedAt }
 *     - history_sessions/{userKey} -> { state, buffer, updatedAt }
 * - 「顯示完資料」時，必定提供 1＝更改、z＝下一步，避免停頓。
 * - 如 index 未傳入 from，會使用 'DEFAULT' 作為 userKey（只作保底示範；請盡快在 index 傳 from）。
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
      console.log('[history] Firebase initialized via FIREBASE_SERVICE_ACCOUNT');
    } else {
      admin.initializeApp(); // 使用預設憑證（如 GOOGLE_APPLICATION_CREDENTIALS）
      console.log('[history] Firebase initialized via default credentials');
    }
  } catch (e) {
    console.error('[history] Firebase init error:', e && e.message ? e.message : e);
    throw e;
  }
})();
const db = admin.firestore();

// ---------- 狀態常數 ----------
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

const PMH_OPTIONS = [
  '高血壓', //1
  '糖尿病', //2
  '心臟病', //3
  '腎臟病', //4
  '肝病',   //5
  '中風',   //6
  '癌症',   //7
  '其他',   //8
  '無'      //9
];

const YES = '1';
const NO  = '2';

// ---------- 小工具 ----------
const nowTS = () => admin.firestore.FieldValue.serverTimestamp();

function userKeyOrDefault(from) {
  const raw = (from || '').toString().replace(/^whatsapp:/i, '').trim();
  return raw || 'DEFAULT';
}
function isZ(input)      { return typeof input === 'string' && /^z$/i.test(input.trim()); }
function isOne(input)    { return (input || '').trim() === '1'; }
function isYesNo(v)      { return v === YES || v === NO; }
function isEmpty(s)      { return !s || s.trim().length === 0; }

function initHistory(){
  return {
    pmh: [],
    meds: [],
    allergies: { types: [], items: [] },
    social: { smoking:'', alcohol:'', travel:'' }
  };
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
function renderPMHMenu(){
  return '請選擇您曾經患有的疾病（可複選，用逗號分隔數字）：\n' +
    PMH_OPTIONS.map((t,i)=>`${i+1}️⃣ ${t}`).join('\n');
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
function renderReview(h){
  return `感謝您提供病史資料 🙏\n以下是您剛填寫的內容：\n${renderSummary(h)}\n\n請問需要更改嗎？\n1️⃣ 需要更改\nz️⃣ 進入下一步`;
}

// ---------- Firestore I/O ----------
async function getSession(userKey) {
  const ref = db.collection('history_sessions').doc(userKey);
  const s = await ref.get();
  if (s.exists) return s.data();
  const fresh = { state: STATES.ENTRY, buffer: {}, updatedAt: nowTS() };
  await ref.set(fresh);
  return fresh;
}
async function saveSession(userKey, patch) {
  await db.collection('history_sessions').doc(userKey).set({ ...patch, updatedAt: nowTS() }, { merge: true });
}
async function getHistory(userKey) {
  const ref = db.collection('history').doc(userKey);
  const s = await ref.get();
  return s.exists ? (s.data()?.history || null) : null;
}
async function saveHistory(userKey, historyObj) {
  await db.collection('history').doc(userKey).set({ history: historyObj, updatedAt: nowTS() }, { merge: true });
}

// ---------- 主處理器 ----------
async function handleHistory({ msg, from }) {
  const body = (msg || '').trim();
  const userKey = userKeyOrDefault(from);

  // 讀取目前 session & history
  let session = await getSession(userKey);
  let history = await getHistory(userKey);

  // 入口
  if (session.state === STATES.ENTRY) {
    if (history) {
      session.state = STATES.SHOW_EXISTING;
      await saveSession(userKey, session);
      return {
        text:
`👉 第 4 步：讀取病人病史模組
已找到你之前輸入的病史資料：
${renderSummary(history)}

是否需要更改？
1️⃣ 需要更改
z️⃣ 進入下一步`,
        done: false
      };
    } else {
      session.state = STATES.FIRST_NOTICE;
      await saveSession(userKey, session);
      return {
        text:
`👉 第 4 步：讀取病人病史模組
首次使用此電話號碼，我們會收集基本病史資料（約 2–3 分鐘）。

請按 z 開始。`,
        done: false
      };
    }
  }

  // 顯示舊資料，決定是否更改
  if (session.state === STATES.SHOW_EXISTING) {
    if (isOne(body)) {
      session.state = STATES.PMH_SELECT;
      session.buffer = { history: initHistory() };
      await saveSession(userKey, session);
      return { text: renderPMHMenu(), done: false };
    }
    if (isZ(body)) {
      session.state = STATES.DONE;
      await saveSession(userKey, session);
      return { text: '✅ 病史已確認無需更改，將進入下一步。', done: true };
    }
    return { text: '請回覆：1＝需要更改，或 z＝進入下一步。', done: false };
  }

  // 首次說明 → 開始填寫
  if (session.state === STATES.FIRST_NOTICE) {
    if (!isZ(body)) return { text: '請按 z 開始。', done: false };
    session.state = STATES.PMH_SELECT;
    session.buffer = { history: initHistory() };
    await saveSession(userKey, session);
    return { text: renderPMHMenu(), done: false };
  }

  // PMH（複選）
  if (session.state === STATES.PMH_SELECT) {
    const idxs = commaNumListToIndices(body);
    if (!idxs.length || !idxs.every(n=>n>=1 && n<=PMH_OPTIONS.length)) {
      return { text: '格式不正確，請以逗號分隔數字，例如：1,2 或 1,3,7\n\n' + renderPMHMenu(), done: false };
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
      await saveSession(userKey, session);
      return { text: '請輸入「其他」的具體病名（可多個，以逗號或頓號分隔）', done: false };
    }
    session.state = STATES.MEDS_YN;
    await saveSession(userKey, session);
    return { text: '您目前是否有在服用藥物？\n1️⃣ 有\n2️⃣ 沒有', done: false };
  }

  if (session.state === STATES.PMH_OTHER_INPUT) {
    const extra = body.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
    session.buffer.history.pmh.push(...extra);
    session.state = STATES.MEDS_YN;
    await saveSession(userKey, session);
    return { text: '您目前是否有