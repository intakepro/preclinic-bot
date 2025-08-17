// index.js v3.3.0
// 功能：修正 restart/初次進入 → 自動發送 2 條訊息（歡迎 + Step1）
// 已整合：name_input + history
// 其他模組仍為佔位（輸入 0 可跳過）

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
    `（未來你完成此模組後，把這裡替換為實際的函式呼叫即可）`
  ].join('\n');
}

function welcomeText() {
  return [
    '👋 歡迎使用 X 醫生問診系統，我哋而家開始啦⋯⋯😊',
    '此版本會依序呼叫 7 個模組。',
    '第 1 步已整合「輸入病人名字模組」，第 4 步已整合「病史模組」。',
    '其餘步驟暫時為佔位畫面。',
    '（在第 1 步中，數字 0 代表「上一頁」；在第 2～7 步中，數字 0 代表「前進」。）',
    '輸入「restart」可隨時回到第 1 步；輸入「help」查看指令。'
  ].join('\n');
}

function helpText() {
  const lines = STEPS.map(s => `  ${s.id}. ${s.name}`);
  return [
    '📖 指令說明：',
    '  0        ➝ 在第 1 步：回上一頁；在第 2～7 步：跳到下一個流程',
    '  restart  ➝ 回到第 1 步',
    '  help     ➝ 顯示此說明',
    '',
    '📌 流程步驟：',
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

// ====== Webhook ======
app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();
  const from = (req.body.From || '').toString();
  const msg  = (req.body.Body || '').toString().trim();

  const session = getSession(from);
  const currentStep = STEPS[session.stepIndex];

  // restart / 初次進入 → 兩條訊息（welcome + Step1 問題）
  if (/^restart$/i.test(msg) || (session.stepIndex === 0 && !msg)) {
    session.stepIndex = 0;
    twiml.message(welcomeText());
    twiml.message('👉 請開始第 1 步：輸入病人姓名');
    return res.type('text/xml').send(twiml.toString());
  }

  // help
  if (/^help$/i.test(msg)) {
    twiml.message(helpText());
    return res.type('text/xml').send(twiml.toString());
  }

  // Step 1：name_input
  if (currentStep.key === 'name_input') {
    const result = await handleNameInput({
      req, res, from, msg,
      advanceNext: () => { session.stepIndex = 1; }
    });
    if (applyAutoNext(result, session, 1)) return;
    if (result && result.replied) return;
    twiml.message('（系統已處理你的輸入）');
    return res.type('text/xml').send(twiml.toString());
  }

  // Step 4：history（已完成，❌ 不再允許 0 跳過）
  if (currentStep.key === 'history') {
    const result = await handleHistory({ from, body: msg });
    if (applyAutoNext(result, session, 4)) return;
    if (result && result.replied) return;
    twiml.message('（系統已處理你的輸入）');
    return res.type('text/xml').send(twiml.toString());
  }

  // 其他佔位模組 → 可用 0 跳過
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

  // 一般輸入 → 回佔位訊息
  twiml.message(placeholderMessage(currentStep));
  return res.type('text/xml').send(twiml.toString());
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor AI flow server running v3.3.0'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
