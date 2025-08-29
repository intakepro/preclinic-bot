// modules/interview.js
// Version: v1.2.1
// 與 index.js 相容：index 只傳 {from, msg}；本模組自行管理 Firestore sessions.interview_step
// 流程：location(多層) → symptom_selector → symptom_detail → done

const admin = require('firebase-admin');
const db = admin.firestore();

// 依你的專案結構：location/symptom 檔案位於 modules/interview/ 底下
const { handleLocation } = require('./interview/location');

// 安全載入（未實作時不會炸掉）
let handleSymptomSelector = async () => ({ text: '🧪 症狀選擇模組未接線，暫時跳過。', done: true });
let handleSymptomDetail   = async () => ({ text: '🧪 症狀細節模組未接線，暫時完成。', done: true });
try {
  const modSel = require('./interview/symptom_selector');
  if (typeof modSel.handleSymptomSelector === 'function') handleSymptomSelector = modSel.handleSymptomSelector;
} catch (_) {}
try {
  const modDet = require('./interview/symptom_detail');
  if (typeof modDet.handleSymptomDetail === 'function') handleSymptomDetail = modDet.handleSymptomDetail;
} catch (_) {}

const SESSIONS = 'sessions';
const keyOf = (from) => (from || '').toString().replace(/^whatsapp:/i, '').trim();

async function getSession(from) {
  const ref = db.collection(SESSIONS).doc(keyOf(from));
  const snap = await ref.get();
  return snap.exists ? (snap.data() || {}) : {};
}
async function setSession(from, patch) {
  const ref = db.collection(SESSIONS).doc(keyOf(from));
  await ref.set({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

async function handleInterview({ from, msg }) {
  const ses = await getSession(from);
  const step = ses.interview_step || 'location';

  // 1) 位置（可多層直到最底層）
  if (step === 'location') {
    const r = await handleLocation({ from, msg }); // location.js 自行管理 selectedLocationPath
    if (r?.done) {
      // 底層已選定，但整個問診還沒結束 → 切換到症狀階段（index 仍停在 interview）
      await setSession(from, { interview_step: 'symptom_selector', finalLocation: r.finalLocation || ses.finalLocation });
      return { text: r.text, done: false };
    }
    return r;
  }

  // 2) 症狀選擇
  if (step === 'symptom_selector') {
    const r = await handleSymptomSelector({ from, msg });
    if (r?.done) {
      await setSession(from, { interview_step: 'symptom_detail', selectedSymptom: r.selectedSymptom || null });
      return { text: r.text, done: false };
    }
    return r;
  }

  // 3) 症狀細節
  if (step === 'symptom_detail') {
    const r = await handleSymptomDetail({ from, msg });
    if (r?.done) {
      await setSession(from, { interview_step: 'complete', symptomDetail: r.detail || null });
      return { text: r.text, done: true }; // ✅ 只有這裡才讓 index 前進到下一全域模組
    }
    return r;
  }

  // 修復未知狀態
  await setSession(from, { interview_step: 'location' });
  return { text: '已回到位置選擇，請選擇你的不適部位。', done: false };
}

module.exports = { handleInterview };