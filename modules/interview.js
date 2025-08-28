// modules/interview.js
// Version: v2.0.1
// 功能：控制整個問診流程（目前處理 location 選單）

const { handle: handleLocation } = require('./interview/location');
const admin = require('firebase-admin');
const db = admin.firestore();

function phoneOf(from) {
  return (from || '').toString().replace(/^whatsapp:/i, '').trim() || 'DEFAULT';
}

async function getSession(from) {
  const ref = db.collection('sessions').doc(phoneOf(from));
  const snap = await ref.get();
  return snap.exists ? snap.data() : { step: 1 };
}

async function setSession(from, patch) {
  const ref = db.collection('sessions').doc(phoneOf(from));
  await ref.set({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

async function handle({ from, msg }) {
  const session = await getSession(from);
  const step = session?.step || 1;

  if (step === 1) {
    const out = await handleLocation({ from, msg });
    const isDone = out.done || false;

    if (isDone) {
      await setSession(from, { step: 2 });
    }

    return {
      texts: Array.isArray(out.texts) ? out.texts : [out.text],
      done: isDone
    };
  }

  return {
    texts: ['📌 尚未實作此步驟，請按 z 返回或等待功能上線。'],
    done: false
  };
}

module.exports = { handle };