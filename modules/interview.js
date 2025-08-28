// modules/interview/interview.js
// Version: v1.1.0
// 功能：負責控制問診流程：location → symptom_selector → symptom_detail

const { handleLocation } = require('./interview/location');
const { handleSymptomSelector } = require('./interview/symptom_selector');
const { handleSymptomDetail } = require('./interview/symptom_detail');

async function handleInterview({ from, msg, session, db }) {
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