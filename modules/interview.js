// modules/interview.js
// Version: v2.1.0
// 功能：控制整個問診流程（處理 location 選單）

const { handle: handleLocation } = require('./interview/location');
const admin = require('firebase-admin');
const db = admin.firestore();

async function handle({ from, msg }) {
  // ⛳ 加入 session 抓取（因 location.js 需要）
  const sessionRef = db.collection('sessions').doc(from.replace(/^whatsapp:/, ''));
  const snap = await sessionRef.get();
  const session = snap.exists ? snap.data() : {};

  const step = session?.step || 1;

  if (step === 1) {
    const out = await handleLocation({ from, msg, session });
    const isDone = out.done || false;

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