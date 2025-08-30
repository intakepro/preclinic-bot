// modules/interview.js
// Orchestrator v2.1.1 — location → symptom_selector(v2.1) → symptom_detail
'use strict';

const admin = require('firebase-admin');
const db = admin.firestore();

console.log('[interview] orchestrator loaded v2.1.1');

const { handleLocation }        = require('./interview/location');
const { handleSymptomSelector } = require('./interview/symptom_selector');
const { handleSymptomDetail }   = require('./interview/symptom_detail');

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
  const st = (s && s.interview_stage) || 'location';
  if (['location','symptom_selector','symptom_detail','done'].includes(st)) return st;
  return 'location';
}

async function handleInterview({ from, msg }) {
  const ses = await getSession(from);
  const stage = currentStage(ses);

  // 1) 位置
  if (stage === 'location') {
    const r = await handleLocation({ from, msg }) || {};
    const texts = toArrayTexts(r);
    if (!r.done) return { texts, done: false };

    await setSession(from, { interview_stage: 'symptom_selector' });
    const r2 = await handleSymptomSelector({ from, msg: '' }) || {};
    return { texts: toArrayTexts(r2), done: false };
  }

  // 2) 症狀多選
  if (stage === 'symptom_selector') {
    const r = await handleSymptomSelector({ from, msg }) || {};
    if (!r.done) return { texts: toArrayTexts(r), done: false };

    await setSession(from, { interview_stage: 'symptom_detail' });
    const r2 = await handleSymptomDetail({ from, msg: '' }) || {};
    return { texts: toArrayTexts(r2).length ? toArrayTexts(r2) : ['✅ 症狀已選定，開始詳問⋯⋯'], done: false };
  }

  // 3) 症狀詳問
  if (stage === 'symptom_detail') {
    const r = await handleSymptomDetail({ from, msg }) || {};
    if (!r.done) return { texts: toArrayTexts(r), done: false };

    await setSession(from, { interview_stage: 'done' });
    return { texts: toArrayTexts(r).length ? toArrayTexts(r) : ['✅ 已完成詳問，交由 AI 整理⋯⋯'], done: true };
  }

  return { text: '✅ 問診子流程已完成。', done: true };
}

module.exports = { handleInterview };