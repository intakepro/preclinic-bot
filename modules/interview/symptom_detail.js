// modules/interview/symptom_detail.js
// Version: v1.0.0
// 功能：根據選定病徵，自動逐題提問並記錄回答至 Firestore

const admin = require('firebase-admin');
const db = admin.firestore();

const SYMPTOM_STATE_PATH = (phone) => `sessions/${phone}/interview.symptom_detail_state`;
const ANSWERS_PATH       = (phone, sid) => `sessions/${phone}/interview.answers.symptom_details.${sid}`;
const QUESTIONS_PATH     = (sid) => `symptom_questions/${sid}`;

const phoneOf = (from) =>
  (from || '').toString().replace(/^whatsapp:/i, '').trim() || 'DEFAULT';

exports.handle = async ({ from, msg }) => {
  const phone = phoneOf(from);

  // 讀取目前狀態（包含 symptom_id, index）
  const stateSnap = await db.doc(SYMPTOM_STATE_PATH(phone)).get();
  const stateData = stateSnap.exists ? stateSnap.data() : {};
  const symptomId = stateData.symptom_id;
  const index     = typeof stateData.index === 'number' ? stateData.index : 0;

  if (!symptomId) {
    return { text: '⚠️ 尚未選定病徵，請先回到 symptom_selector 選擇。', done: true };
  }

  // 讀取 symptom 對應的提問題目
  const qSnap = await db.doc(QUESTIONS_PATH(symptomId)).get();
  if (!qSnap.exists) {
    return { text: `⚠️ ${symptomId} 的問題尚未建立，請稍後再試。`, done: true };
  }

  const questions = qSnap.data().questions || [];
  if (index >= questions.length) {
    // 問完所有問題 → 清除狀態
    await db.doc(SYMPTOM_STATE_PATH(phone)).delete();
    return { text: `✅「${symptomId}」相關提問完成。`, done: true };
  }

  const currQ = questions[index];

  // 如果不是第一次顯示，要先記錄上一題的答案
  if (msg && index > 0) {
    const prevQ = questions[index - 1];
    const ansPath = ANSWERS_PATH(phone, symptomId);
    const ansRef  = db.doc(ansPath);
    await ansRef.set({ [prevQ.field]: msg }, { merge: true });
  }

  // 更新狀態：前進下一題
  await db.doc(SYMPTOM_STATE_PATH(phone)).set({
    symptom_id: symptomId,
    index: index + 1,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 顯示目前這一題
  let text = `📝 ${currQ.label}`;
  if (Array.isArray(currQ.input) && currQ.input.length > 0) {
    text += '\n\n請輸入：\n' + currQ.input.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
  } else if (currQ.type === 'text') {
    text += '\n\n請自由輸入你的描述。';
  }

  return { text, done: false };
};