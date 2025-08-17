// index.js v3.0
// WhatsApp 問診 7 步驟 Demo
// 已接入：name_input, history
// 新增：統一回上一題規則 + 歡迎語 + autoNext

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;

const { handleNameInput } = require('./modules/name_input');
const { handleHistory } = require('./modules/history_module');

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
    `（未來完成此模組後，把這裡替換為實際的函式呼叫即可）`
  ].join('\n');
}

function welcomeText() {
  return [
    '👋 歡迎使用 X 醫生問診系統，我哋而家開始啦⋯⋯😊',
    '',
    '此版本會依序呼叫 7 個模組。',
    '第 1 步已整合「輸入病人名字模組」，第 4 步已整合「病史模組」。',
    '其餘步驟暫時為佔位畫面。',
    '',
    '📌 使用指令：',
    '  restart  ➝ 回到第 1 步',
    '  help     ➝ 顯示步驟清單',
    '',
    '（在第 1 步，數字 0 代表「上一頁」；',
    ' 在第 2～7 步的佔位模組中，數字 0 代表「前進」。）',
  ].join('\n');
}

function helpText() {
  const lines = STEPS.map(s => `  ${s.id}. ${s.name}`);
  return [
    '📖 流程步驟清單：',
    ...lines
  ].join('\n');
}

// ====== 自動前進 helper ======
function applyAutoNext(result, session, nextIndex) {
  if (result && result.autoNext === true) {
    session.stepIndex = nextIndex;
  }
  return result && result.replied;
}

// Webhook
app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();
  const from = (req.body.From || '').toString();
  const msg  = (req.body.Body || '').toString().trim();

  const session = getSession(from);
  const currentStep = STEPS[session.stepIndex];

  // restart / help
  if (/^restart$/i.test(msg)) {
    session.stepIndex = 0;
    twiml.message(welcomeText());
    return res.type('text/xml').send(twiml.toString());
  }
  if (/^help$/i.test(msg)) {
    twiml.message(helpText());
    return res.type('text/xml').send(twiml.toString());
  }

  // Step 1：name_input（支援回上一題）
  if (currentStep.key === 'name_input') {
    const result = await handleNameInput({ req, res, from, msg });
    if (applyAutoNext(result, session, 1)) return;
    if (result && result.replied) return;
    twiml.message('（系統已處理你的輸入）');
    return res.type('text/xml').send(twiml.toString());
  }

  // Step 4：history（❌ 不允許 0 跳過）
  if (currentStep.key === 'history') {
    const result = await handleHistory({ from, body: msg });
    if (applyAutoNext(result, session, 4)) return;
    if (result && result.replied) return;
    twiml.message('（系統已處理你的輸入）');
    return res.type('text/xml').send(twiml.toString());
  }

  // 其他佔位模組：0 ➝ 下一步
  if (msg === '0') {
    if (session.stepIndex < STEPS.length - 1) {
      session.stepIndex += 1;
      const nextStep = STEPS[session.stepIndex];
      twiml.message(placeholderMessage(nextStep));
      return res.type('text/xml').send(twiml.toString());
    } else {
      twiml.message('✅ 問診已完成，你的資料已傳送給醫生，祝你早日康復 ❤️');
      res.type('text/xml').send(twiml.toString());
      setTimeout(() => process.exit(0), 1000);
      return;
    }
  }

  // 一般輸入 → 顯示 placeholder
  twiml.message(placeholderMessage(currentStep));
  return res.type('text/xml').send(twiml.toString());
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor AI flow server running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
