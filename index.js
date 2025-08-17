/**
 * Module: index.js
 * Version: v3.2.0
 * Date: 2025-08-17
 * 更新內容：
 * - 修正 restart/首次進入時只停留在歡迎畫面：現在直接委派到 name_input 問第一題（自動開始）
 * - 保持「0 僅適用佔位模組」，第 4 步 history 取消 0 跳過
 * - 兼容模組回傳 {replied, autoNext} / 純文字 + [[AUTO_NEXT]] / 純文字
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

// UI（歡迎語仍保留作為文案，實際由 name_input 發第一題）
function welcomeText() {
  return [
    '👋 歡迎使用 X 醫生問診系統，我哋而家開始啦⋯⋯😊',
    '',
    '提示：任何題目可用 0 / prev / ← 回上一題（由各模組處理）。',
    '在尚未完成的佔位步驟（2/3/5/6/7）輸入 0 會跳到下一步。'
  ].join('\n');
}
function placeholderMessage(step) {
  return [
    `🔧 【${step.id}. ${step.name}】`,
    `此步驟暫為佔位畫面。請輸入「0」跳去下一個流程。`
  ].join('\n');
}

// —— 模組回傳標準化 ——
function normalizeModuleResult(result) {
  if (result && typeof result === 'object') {
    return { replied: !!result.replied, autoNext: !!result.autoNext, text: result.text ?? null, type: 'object' };
  }
  if (typeof result === 'string') {
    const hasAuto = result.includes('[[AUTO_NEXT]]');
    return { replied: false, autoNext: hasAuto, text: result.replace('[[AUTO_NEXT]]', '').trim(), type: 'text' };
  }
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

  // ===== restart：直接進入第 1 步（由 name_input 發第一題；不單獨停在歡迎語） =====
  if (/^restart$/i.test(msg)) {
    session.stepIndex = 0;
    // 把歡迎語當前置提示附在第一題上（做法：先送歡迎，再立刻把第一題交給模組）
    // 由於 Twilio 每次只能回一則訊息，這裡選擇讓模組直接回第一題，歡迎語由模組文案或後續訊息帶出
    return handleNameInput({ req, res, from, msg: '' }); // 直接開始第 1 步
  }

  // ===== 首次進入（空訊息、且在 step 0）也直接開始第 1 步 =====
  if (msg === '' && session.stepIndex === 0) {
    return handleNameInput({ req, res, from, msg: '' }); // 不停留在歡迎畫面
  }

  // ===== 第 1 步：name_input（完成 autoNext->Step 2）=====
  if (currentStep.key === 'name_input') {
    const raw = await handleNameInput({ req, res, from, msg });
    const r = normalizeModuleResult(raw);
    if (r.replied) { if (r.autoNext) advance(session, 1); return; }
    if (r.text) {
      if (r.autoNext) { advance(session, 1); twiml.message(r.text + '\n\n' + placeholderMessage(STEPS[session.stepIndex])); }
      else { twiml.message(r.text); }
      return res.type('text/xml').send(twiml.toString());
    }
    return res.status(204).end();
  }

  // ===== 第 4 步：history（❌ 不允許 0 跳過；看 autoNext 決定是否前進）=====
  if (currentStep.key === 'history') {
    const raw = await handleHistory({ from, body: msg });
    const r = normalizeModuleResult(raw);
    if (r.replied) { if (r.autoNext) advance(session, 1); return; }
    if (r.text) {
      if (r.autoNext) { advance(session, 1); twiml.message(r.text + '\n\n' + placeholderMessage(STEPS[session.stepIndex])); }
      else { twiml.message(r.text); }
      return res.type('text/xml').send(twiml.toString());
    }
    return res.status(204).end();
  }

  // ===== 其他佔位模組：0 ➝ 下一步（統一處理）=====
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

  // 其他任何輸入 → 回當前步驟的佔位提示
  twiml.message(placeholderMessage(currentStep));
  return res.type('text/xml').send(twiml.toString());
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor AI flow server running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
