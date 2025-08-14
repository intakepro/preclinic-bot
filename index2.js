// index.js
// WhatsApp 問診 7 步驟 Demo（佔位模組版）：每步輸入「0」前進；第 7 步完成後回覆並結束程式
//
// 依賴：express、body-parser、twilio
// 安裝：npm i express body-parser twilio
//
// 啟動：node index.js
// Webhook：POST /whatsapp
//
// 注意：目前使用「記憶體 Session」保存每個電話的流程步驟（適合本機測試）。
//       上線請改成 Firestore 或其他持久化儲存。
//       在 Render 上 process.exit(0) 會導致服務重啟，若不希望如此請註解該行。

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ====== 流程步驟定義（7 個）======
const STEPS = [
  { id: 1, key: 'name_input', name: '輸入病人名字模組' },
  { id: 2, key: 'auth',       name: '病人問診權限檢查模組' },
  { id: 3, key: 'profile',    name: '讀取病人資料模組' },
  { id: 4, key: 'history',    name: '讀取病人病史模組' },
  { id: 5, key: 'interview',  name: '問診系統模組' },
  { id: 6, key: 'ai_summar',  name: 'AI整理模組' },
  { id: 7, key: 'export',     name: '匯出總結模組' },
];

// 記憶體 Session：{ [fromPhone]: { stepIndex: 0..6 } }
const sessions = new Map();

// 取得或建立 Session
function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, { stepIndex: 0 }); // 從第 1 步（index 0）開始
  }
  return sessions.get(from);
}

// 產生佔位提示訊息
function placeholderMessage(step) {
  return [
    `🔧 【${step.id}. ${step.name}】`,
    `該模組製作中，請輸入「0」跳去下一個流程。`,
    `（未來你完成此模組後，把這裡替換為實際的函式呼叫即可）`
  ].join('\n');
}

// 首次歡迎文案
function welcomeText() {
  return [
    '👋 歡迎使用預先問診流程（Demo 版本）',
    '此版本會依序呼叫 7 個模組（目前為佔位畫面）。',
    '在每個步驟輸入「0」即可跳至下一個流程。',
    '輸入「restart」可隨時回到第 1 步；輸入「help」查看指令。'
  ].join('\n');
}

// 說明文案
function helpText() {
  const lines = STEPS.map(s => `  ${s.id}. ${s.name}`);
  return [
    '📖 指令說明：',
    '  0        ➝ 跳到下一個流程',
    '  restart  ➝ 回到第 1 步',
    '  help     ➝ 顯示此說明',
    '',
    '📌 流程步驟：',
    ...lines
  ].join('\n');
}

// WhatsApp Webhook
app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();

  const from = req.body.From || 'unknown';
  const msg  = (req.body.Body || '').trim();
  const session = getSession(from);

  // 指令處理
  if (/^restart$/i.test(msg)) {
    session.stepIndex = 0;
    twiml.message(welcomeText() + '\n\n' + placeholderMessage(STEPS[0]));
    return res.type('text/xml').send(twiml.toString());
  }

  if (/^help$/i.test(msg)) {
    twiml.message(helpText());
    return res.type('text/xml').send(twiml.toString());
  }

  const currentStep = STEPS[session.stepIndex];

  if (msg === '0') {
    // 尚未到最後一步：前進
    if (session.stepIndex < STEPS.length - 1) {
      session.stepIndex += 1;
      const nextStep = STEPS[session.stepIndex];
      twiml.message(placeholderMessage(nextStep));
      return res.type('text/xml').send(twiml.toString());
    } else {
      // 已在第 7 步，顯示完成訊息並結束程式
      twiml.message('✅ 問診已完成，你的資料已傳送給醫生，謝謝你，祝你身體早日康復❤️');
      res.type('text/xml').send(twiml.toString());

      // 給 Twilio 一點時間收到回覆再結束程式
      setTimeout(() => {
        // 若不想在雲端退出，請註解下一行
        process.exit(0);
      }, 1000);
      return;
    }
  }

  // 非 0 的一般輸入：回覆目前步驟的佔位提示（首次互動則帶歡迎）
  twiml.message(
    (msg === '' ? welcomeText() + '\n\n' : '') + placeholderMessage(currentStep)
  );
  return res.type('text/xml').send(twiml.toString());
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor AI flow server running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});



