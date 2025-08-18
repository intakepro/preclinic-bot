/**
 * File: modules/history.js
 * Version: v6.2.1-fs-composite
 * Interface: async handleHistory({ msg, from, patientId, patientName }) -> { text, done }
 *
 * 更新內容：
 * - 保持 ENTRY→SHOW_EXISTING 時列出「病人名稱 + 電話末4」與完整病史摘要，並提供 1/z 選項。
 * - DONE 狀態不靜默：持續提供 1（更改）/ z（完成）以免用戶誤會已卡住。
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

  // ……（中間填寫流程與你 v6.2.0 相同，略）……
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

  // DONE（不靜默）
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