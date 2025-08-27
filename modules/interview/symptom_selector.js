// modules/interview/symptom_selector.js
// Version: v2.0.0
// 功能：根據 location_id 顯示病徵清單，讓使用者選擇，並記錄至 Firestore 給 symptom_detail 使用
// 資料來源：data/symptoms_by_location.json
// 使用方式：const { handleSymptomSelection } = require('./interview/symptom_selector');

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const db = admin.firestore();

// 🧾 調用 JSON 症狀清單
const symptomsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../data/symptoms_by_location.json'), 'utf8')
);

// 🔍 找出該部位對應的病徵
function getSymptomList(location_id) {
  const entry = symptomsData.find((item) => item.location_id === location_id);
  return entry ? entry.symptoms : [];
}

// 📞 提取電話
const phoneOf = (from) =>
  (from || '').toString().replace(/^whatsapp:/i, '').trim() || 'DEFAULT';

// 主函式：處理病徵選擇
async function handleSymptomSelection({ from, msg, session, location_id }) {
  const bufferKey = `symptom_selector_${location_id}`;
  const symptoms = getSymptomList(location_id);
  const phone = phoneOf(from);

  if (!session.buffer) session.buffer = {};

  // ➤ 初次進入顯示清單
  if (!msg || msg.trim() === '') {
    if (!symptoms.length) {
      return {
        text: `❌ 系統內無「${location_id}」對應的病徵資料，請聯絡管理員處理。`,
        done: true
      };
    }

    session.buffer[bufferKey] = { symptoms };

    let text = `👁️ 請問你在「${location_id}」部位感覺到什麼症狀？請輸入號碼選擇：`;
    symptoms.forEach((symptom, i) => {
      text += `\n${i + 1}️⃣ ${symptom.name_zh}`;
    });
    text += `\n\n0️⃣ 返回上一層`;
    return { text, done: false };
  }

  // ➤ 使用者輸入處理
  const choice = parseInt(msg);
  if (isNaN(choice)) {
    return { text: `⚠️ 請輸入對應的數字。`, done: false };
  }

  if (choice === 0) {
    return {
      text: `🔙 返回上一層。請重新選擇身體部位。`,
      done: true,
      nextStep: 'location'
    };
  }

  const selected = session.buffer?.[bufferKey]?.symptoms?.[choice - 1];
  if (!selected) {
    return {
      text: `❌ 無效選項，請重新輸入正確號碼。`,
      done: false
    };
  }

  // ✅ 儲存所選病徵（暫存於 session）
  session.selectedSymptom = selected.symptom_id;

  // ✅ 寫入 Firestore 給 symptom_detail.js 使用
  await db.doc(`sessions/${phone}/interview.symptom_detail_state`).set({
    symptom_id: selected.symptom_id,
    index: 0,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return {
    text: `✅ 你選擇的病徵是：${selected.name_zh}（${selected.name_en}）\n接下來會問你一些細節問題。`,
    done: true,
    selectedSymptom: selected.symptom_id
  };
}

module.exports = { handleSymptomSelection };