// modules/interview/symptom_selector.js
// Version: 1.0.0
// 功能：根據 location_id 顯示病徵清單，讓使用者選擇（通用模組）
// 資料來源：data/symptoms_by_location.json
// 使用方式：const { handleSymptomSelection } = require('./interview/symptom_selector');

const fs = require('fs');
const path = require('path');

// 讀取病徵清單 JSON（格式：[{ location_id: 'eye', symptoms: [...] }, ...]）
const symptomsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../data/symptoms_by_location.json'), 'utf8')
);

// 取得某個部位的病徵清單
function getSymptomList(location_id) {
  const entry = symptomsData.find((item) => item.location_id === location_id);
  return entry ? entry.symptoms : [];
}

// 主處理函式
async function handleSymptomSelection({ from, msg, session, location_id }) {
  const bufferKey = `symptom_selector_${location_id}`;
  const symptoms = getSymptomList(location_id);

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

  // ➤ 儲存所選病徵
  session.selectedSymptom = selected.symptom_id;

  return {
    text: `✅ 你選擇的病徵是：${selected.name_zh}（${selected.name_en}）`,
    done: true,
    selectedSymptom: selected.symptom_id
  };
}

module.exports = { handleSymptomSelection };