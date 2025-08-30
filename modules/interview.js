// modules/interview.js
// Orchestrator v2.1 — 控制整個問診子流程：location → symptom_selector(v2.0多選) → symptom_detail
// 對外介面：handleInterview({ from, msg })，回傳 {text|texts, done}
// 外層 index.js 仍然只接這個模組，不用改。

'use strict';

const admin = require('firebase-admin');
const db = admin.firestore();

// 子模組
const { handleLocation }         = require('./interview/location');
const { handleSymptomSelector }  = require('./interview/symptom_selector'); // v2.0 多選版
const { handleSymptomDetail }    = require('./interview/symptom_detail');   // v1.x

const SESSIONS = 'sessions';
const keyOf = (from) => (from || '').toString().replace(/^whatsapp:/i, '').trim();

async function getSession(from) {
  const snap = await db.collection(SESSIONS).doc(keyOf(from)).get();
  return snap.exists ? (snap.data() || {}) : {};
}
async function setSession(from, patch) {
  await db.collection(SESSIONS).doc(keyOf(from))
    .set({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}
function toArrayTexts(out) {
  if (!out) return [];
  if (Array.isArray(out.texts)) return out.texts.filter(t => typeof t === 'string' && t.trim());
  if (typeof out.text === 'string' && out.text.trim()) return [out.text];
  return [];
}

function currentStage(s) {
  // 既有 session 沒有 stage 時，從 location 開始
  const st = (s && s.interview_stage) || 'location';
  if (['location','symptom_selector','symptom_detail','done'].includes(st)) return st;
  return 'location';
}

module.exports = {
  handleInterview: async ({ from, msg }) => {
    const ses = await getSession(from);
    const stage = currentStage(ses);

    // ── 1) 部位選擇
    if (stage === 'location') {
      const r = await handleLocation({ from, msg }) || {};
      const texts = toArrayTexts(r);

      if (!r.done) {
        return { texts, done: false };
      }

      // 到達最底層 → 進入症狀多選
      await setSession(from, { interview_stage: 'symptom_selector' });
      const r2 = await handleSymptomSelector({ from, msg: '' }) || {};
      const t2 = toArrayTexts(r2);
      return { texts: [...texts, ...t2], done: false };
    }

    // ── 2) 症狀多選（v2.0）
    if (stage === 'symptom_selector') {
      const r = await handleSymptomSelector({ from, msg }) || {};
      const texts = toArrayTexts(r);

      if (!r.done) {
        return { texts, done: false };
      }

      // 完成多選 → 進入逐個詳問
      await setSession(from, { interview_stage: 'symptom_detail' });
      const r2 = await handleSymptomDetail({ from, msg: '' }) || {};
      const t2 = toArrayTexts(r2);
      return { texts: t2.length ? t2 : ['✅ 症狀已選定，將開始詳問⋯⋯'], done: false };
    }

    // ── 3) 症狀詳問（逐個症狀）
    if (stage === 'symptom_detail') {
      const r = await handleSymptomDetail({ from, msg }) || {};
      const texts = toArrayTexts(r);

      if (!r.done) {
        return { texts, done: false };
      }

      // 詳問全數完成且已同意交 AI（symptom_detail 會在 consent=1 時回 done:true）
      await setSession(from, { interview_stage: 'done' });
      // 交回外層 index.js，讓它前進到下一個大步（通常是 ai_summar）
      return { texts: texts.length ? texts : ['✅ 已完成詳問，交由 AI 整理⋯⋯'], done: true };
    }

    // ── 4) 其他/完成
    return { text: '✅ 問診子流程已完成。', done: true };
  }
};