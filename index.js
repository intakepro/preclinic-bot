/**
 * Module: index.js
 * Version: v3.1.0
 * Date: 2025-08-17
 * 變更摘要：
 * - 兼容模組回傳三種型式：{replied, autoNext} / 純文字含 [[AUTO_NEXT]] / 純文字
 * - 修正 history 模組完成後不前進與多餘訊息的問題
 * - 保持規則：0 只適用於佔位模組；第 4 步不可用 0 跳過
 * - 首次進入顯示歡迎語；完成步驟自動前進（autoNext）
 */

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
  { id: 2, key: 'auth',       name: '病人問診權限檢查模組（佔位）' },
  { id: 3, key: 'profile',    name: '讀取病人資料模組（佔位）' },
  { id: 4, key: 'history',    name: '讀取病人病史模組' },
  { id: 5, key: 'interview',  name: '問診系統模組（佔位）' },
  { id: 6, key: 'ai_summar',  name: 'AI整理模組（佔位）' },
  { id: 7, key: 'export',     name: '匯出總結模組（佔位）' },
];

// 記憶體 Session：{ [fromPhone]: { stepIndex, selectedPatient? } }
const sessions = new Map();
function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, { stepIndex: 0, selectedPatient: null });
  }
  return sessions.get(from);
}

// UI
function placeholderMessage(step) {
  return [
    `🔧 【${step.id}. ${step.name}】`,
    `此步驟暫為佔位畫面。請輸入「0」跳去下一個流程。`
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
    '📌 指令：',
    '  restart  ➝ 回到第 1 步',
    '  help     ➝ 顯示步驟清單',
    '',
    '（在第 1 步，數字 0 代表「上一頁」（由模組內處理）；',
    ' 在第 2、3、5、6、7（佔位）可用 0 前進；第 4 步不可用 0 跳過。）'
  ].join('\n');
}
function helpText() {
  const lines = STEPS.map(s => `  ${s.id}. ${s.name}`);
  return ['📖 流程步驟清單：', ...lines].join('\n');
}

// ====== 模組回傳統一處理 ======
function normalizeModuleResult(result) {
  // 物件：{ replied, autoNext, text? }
  if (result && typeof result === 'object') {
    return {
      replied: !!result.replied,
      autoNext: !!result.autoNext,
      text: result.text ?? null,
      type: 'object'
    };
  }
  // 純文字
  if (typeof result === 'string') {
    const hasAuto = result.includes('[[AUTO_NEXT]]');
    return {
      replied: false,          // 由 index 回覆
      autoNext: hasAuto,
      text: hasAuto ? result.replace('[[AUTO_NEXT]]', '').trim() : result,
      type: 'text'
    };
  }
  // 其他 / 空
  return { replied: false, autoNext: false, text: null, type: 'none' };
}

function advance(session, steps = 1) {
  session.stepIndex = Math.min(session.stepIndex + steps, STEPS.length - 1);
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

  // 首次進入（空訊息）顯示歡迎
  if (msg === '' && session.stepIndex === 0) {
    twiml.message(welcomeText());
    return res.type('text/xml').send(twiml.toString());
  }

  // Step 1：name_input（完成後 autoNext -> Step 2）
  if (currentStep.key === 'name_input') {
    const raw = await handleNameInput({ req, res, from, msg });
    const r = normalizeModuleResult(raw);

    // 模組已自行回覆（常見於 name_input）
    if (r.replied) {
      if (r.autoNext) advance(session, 1);
      return; // 不再由 index 回覆
    }

    // 模組回傳純文字（較少見），由 index 回
    if (r.text) {
      if (r.autoNext) {
        advance(session, 1);
        const nextStep = STEPS[session.stepIndex];
        twiml.message(r.text + '\n\n' + placeholderMessage(nextStep));
      } else {
        twiml.message(r.text);
      }
      return res.type('text/xml').send(twiml.toString());
    }

    // 兜底
    twiml.message('（系統已處理你的輸入）');
    return res.type('text/xml').send(twiml.toString());
  }

  // Step 4：history（❌ 禁 0 跳過；兼容物件與文字 + [[AUTO_NEXT]]）
  if (currentStep.key === 'history') {
    const raw = await handleHistory({ from, body: msg });
    const r = normalizeModuleResult(raw);

    if (r.replied) {
      if (r.autoNext) advance(session, 1); // 4 -> 5
      return;
    }

    if (r.text) {
      if (r.autoNext) {
        advance(session, 1);
        const nextStep = STEPS[session.stepIndex];
        twiml.message(r.text + '\n\n' + placeholderMessage(nextStep));
      } else {
        twiml.message(r.text);
      }
      return res.type('text/xml').send(twiml.toString());
    }

    // 兜底：不多發「系統已處理…」，避免干擾
    return res.status(204).end();
  }

  // 其他佔位模組：0 ➝ 下一步
  if (msg === '0') {
    if (session.stepIndex < STEPS.length - 1) {
      advance(session, 1);
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

  // 一般輸入 → 顯示當前步驟佔位提示
  twiml.message(placeholderMessage(currentStep));
  return res.type('text/xml').send(twiml.toString());
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor AI flow server running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
