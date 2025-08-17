// index.js
// WhatsApp 問診 7 步驟 Demo（第 1 步已接入 name_input 模組）

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const { handleNameInput } = require('./modules/name_input');
const { handleHistory } = require('./modules/history_module'); // 新增病史模組

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

// 記憶體 Session：{ [fromPhone]: { stepIndex, selectedPatient? } }
const sessions = new Map();

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, { stepIndex: 0, selectedPatient: null });
  }
  return sessions.get(from);
}

function placeholderMessage(step) {
  return [
    `🔧 【${step.id}. ${step.name}】`,
    `該模組製作中，請輸入「0」跳去下一個流程。`,
    `（未來你完成此模組後，把這裡替換為實際的函式呼叫即可）`
  ].join('\n');
}

// 👇 修改：首次歡迎語
function welcomeText() {
  return [
    '👋 歡迎使用 X 醫生問診系統，我哋而家開始啦⋯⋯😊',
    '',
    '此版本會依序呼叫 7 個模組。',
    '第 1 步已整合「輸入病人名字模組」。',
    '第 2～7 步目前仍為佔位畫面。',
    '（在第 1 步中，數字 0 代表「上一頁」；在第 2～7 步中，數字 0 代表「前進」。）',
    '輸入「restart」可隨時回到第 1 步；輸入「help」查看指令。'
  ].join('\n');
}

function helpText() {
  const lines = STEPS.map(s => `  ${s.id}. ${s.name}`);
  return [
    '📖 指令說明：',
    '  0        ➝ 在第 1 步：回上一頁；在第 2～3、5～7 步：跳到下一個流程',
    '  9        ➝ 在第 4 步（病史模組）：完成後跳去下一步',
    '  restart  ➝ 回到第 1 步',
    '  help     ➝ 顯示此說明',
    '',
    '📌 流程步驟：',
    ...lines
  ].join('\n');
}

// Webhook
app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();
  const from = (req.body.From || '').toString();
  const msg  = (req.body.Body || '').toString().trim();

  const session = getSession(from);
  const currentStep = STEPS[session.stepIndex];

  // 指令：restart / help（任何步驟有效）
  if (/^restart$/i.test(msg)) {
    session.stepIndex = 0;
    twiml.message(welcomeText());
    res.type('text/xml').send(twiml.toString());
    return;
  }
  if (/^help$/i.test(msg)) {
    twiml.message(helpText());
    res.type('text/xml').send(twiml.toString());
    return;
  }

  // 第 1 步：改由模組處理
  if (currentStep.key === 'name_input') {
    const result = await handleNameInput({
      req, res,
      from,
      msg,
      onComplete: ({ phone, patientId, name }) => {
        session.selectedPatient = { phone, patientId, name };
      },
      advanceNext: () => {
        session.stepIndex = 1; // 下一步
      }
    });
    if (result && result.replied) return; // 模組已回覆
    twiml.message('（系統已處理你的輸入）');
    return res.type('text/xml').send(twiml.toString());
  }

  // ★ 第 4 步：病史模組（專屬用 9 前進）
  if (currentStep.key === 'history') {
    if (msg === '9') {
      if (session.stepIndex < STEPS.length - 1) {
        session.stepIndex += 1;
        const nextStep = STEPS[session.stepIndex];
        twiml.message(placeholderMessage(nextStep));
        return res.type('text/xml').send(twiml.toString());
      } else {
        twiml.message('✅ 問診已完成，你的資料已傳送給醫生，謝謝你，祝你身體早日康復❤️');
        res.type('text/xml').send(twiml.toString());
        setTimeout(() => { process.exit(0); }, 1000);
        return;
      }
    }

    try {
      const reply = await handleHistory({ from, body: msg });
      twiml.message(reply || '（空訊息）');
      return res.type('text/xml').send(twiml.toString());
    } catch (e) {
      console.error('[history] error:', e);
      twiml.message('病史模組暫時無法服務，請稍後再試 🙏');
      return res.type('text/xml').send(twiml.toString());
    }
  }

  // 第 2、3、5～7 步：維持原本 0 前進
  if (msg === '0') {
    if (session.stepIndex < STEPS.length - 1) {
      session.stepIndex += 1;
      const nextStep = STEPS[session.stepIndex];
      twiml.message(placeholderMessage(nextStep));
      return res.type('text/xml').send(twiml.toString());
    } else {
      twiml.message('✅ 問診已完成，你的資料已傳送給醫生，謝謝你，祝你身體早日康復❤️');
      res.type('text/xml').send(twiml.toString());
      setTimeout(() => { process.exit(0); }, 1000);
      return;
    }
  }

  // 其他輸入：回覆佔位
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
