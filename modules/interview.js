// modules/interview/interview.js
// Version: v1.1.2
// 功能：支援 symptom_detail 模組、每個子模組回傳 sessionUpdates 時會自動寫入 Firestore

const { handleLocation } = require('./interview/location');
const { handleSymptomSelector } = require('./interview/symptom_selector');
const { handleSymptomDetail } = require('./interview/symptom_detail');
const admin = require('firebase-admin');
const db = admin.firestore();

function phoneOf(from) {
  return (from || '').toString().replace(/^whatsapp:/i, '').trim();
}

async function updateSession(from, updates) {
  if (!updates || Object.keys(updates).length === 0) return;
  const key = phoneOf(from);
  await db.collection('sessions').doc(key).set(
    { ...updates, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

async function handleInterview({ from, msg, session }) {
  session = session || {};

  // Step 1: 身體部位選擇
  if (!session.step || session.step === 'location') {
    const res = await handleLocation({ from, msg, session, db });

    if (res?.done || res?.sessionUpdates) {
      await updateSession(from, res.sessionUpdates);
    }

    if (res?.done) {
      return { ...res, sessionUpdates: { step: 'symptom_selector' } };
    }
    return res;
  }

  // Step 2: 症狀選擇
  if (session.step === 'symptom_selector') {
    const res = await handleSymptomSelector({ from, msg, session, db });

    if (res?.done || res?.sessionUpdates) {
      await updateSession(from, res.sessionUpdates);
    }

    if (res?.done) {
      return { ...res, sessionUpdates: { step: 'symptom_detail' } };
    }
    return res;
  }

  // Step 3: 症狀詳情（onset, duration 等）
  if (session.step === 'symptom_detail') {
    const res = await handleSymptomDetail({ from, msg, session, db });

    if (res?.done || res?.sessionUpdates) {
      await updateSession(from, res.sessionUpdates);
    }

    if (res?.done) {
      return { ...res, sessionUpdates: { step: 'complete' } };
    }
    return res;
  }

  return {
    text: '✅ 問診流程已完成，感謝你的協助。'
  };
}

module.exports = { handleInterview };