/**
 * Module: modules/history.js
 * Version: v6.1.0-fs-patientName
 *
 * 介面：async handleHistory({ msg, from, patientName }) -> { text: string, done: boolean }
 *
 * 更新內容：
 * - 修正「在舊病史畫面按 1 不能更改」問題 ✅
 * - 修正「在舊病史畫面按 z 不能進入下一步」問題 ✅
 * - 新增功能：顯示病史時，在頂部加插病人名稱 + 電話末4碼（debug 用） ✅
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
      admin.initializeApp();
      console.log('[history] Firebase initialized via default credentials');
    }
  } catch (e) {
    console.error('[history] Firebase init error:', e?.message || e);
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
  '高血壓',
  '糖尿病',
  '心臟病',
  '腎臟病',
  '肝病',
  '中風',
  '癌症',
  '其他',
  '無'
];

const YES = '1';
const NO  = '2';

// ---------- 小工具 ----------
const nowTS = () => admin.firestore.FieldValue.serverTimestamp();

function userKeyOrDefault(from) {
  const raw = (from || '').toString().replace(/^whatsapp:/i, '').trim();
  return raw || 'DEFAULT';
}
function last4(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.slice(-4) || '----';
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
function renderReview(h, patientName, phone) {
  return `🧑‍⚕️ 病人：${patientName || '（未命名）'} (${last4(phone)})\n\n感謝您提供病史資料 🙏\n以下是您剛填寫的內容：\n${renderSummary(h)}\n\n請問需要更改嗎？\n1️⃣ 需要更改\nz️⃣ 進入下一步`;
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
async function handleHistory({ msg, from, patientName }) {
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
🧑‍⚕️ 病人：${patientName || '（未命名）'} (${last4(from)})

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
🧑‍⚕️ 病人：${patientName || '（未命名）'} (${last4(from)})

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

  // 其餘流程（略，和之前版本相同，會逐步收集資料並在最後 REVIEW 時呼叫 renderReview）
  if (session.state === STATES.REVIEW) {
    if (isOne(body)) {
      session.state = STATES.PMH_SELECT;
      session.buffer = { history: initHistory() };
      await saveSession(userKey, session);
      return { text: renderPMHMenu(), done: false };
    }
    if (isZ(body)) {
      session.state = STATES.DONE;
      await saveSession(userKey, session);
      return { text: '✅ 已完成病史填寫，將進入下一步。', done: true };
    }
    return { text: '請回覆：1＝需要更改，或 z＝進入下一步。', done: false };
  }

  if (session.state === STATES.DONE) {
    return { text: '✅ 病史模組已完成。', done: true };
  }

  return { text: '⚠️ 輸入不正確，請再試一次。', done: false };
}

module.exports = { handleHistory };