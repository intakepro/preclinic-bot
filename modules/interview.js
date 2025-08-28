// modules/interview/interview.js
// Version: v1.1.1
// 修正：避免 session 為 undefined 導致錯誤

const { handleLocation } = require('./interview/location');
const { handleSymptomSelector } = require('./interview/symptom_selector');
const { handleSymptomDetail } = require('./interview/symptom_detail');

async function handleInterview({ from, msg, session, db }) {
  session = session || {}; // ✅ 加入這一行修正錯誤

  if (!session.step || session.step === 'location') {
    const res = await handleLocation({ from, msg, session, db });
    if (res?.done) {
      return { ...res, sessionUpdates: { step: 'symptom_selector' } };
    }
    return res;
  }

  if (session.step === 'symptom_selector') {
    const res = await handleSymptomSelector({ from, msg, session, db });
    if (res?.done) {
      return { ...res, sessionUpdates: { step: 'symptom_detail' } };
    }
    return res;
  }

  if (session.step === 'symptom_detail') {
    const res = await handleSymptomDetail({ from, msg, session, db });
    if (res?.done) {
      return { ...res, sessionUpdates: { step: 'complete' } };
    }
    return res;
  }

  return { text: '✅ 問診流程已完成，感謝你的協助。' };
}

module.exports = { handleInterview };