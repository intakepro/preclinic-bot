// File: index.js | v0.3.2 (Render Web Service + Twilio WhatsApp Webhook, patient-clean output)
// 說明：病人只看到「STEP + 模組名稱 + 製作中」；檔名與版本只寫入伺服器 log。
// 指令：任何時候輸入 "restart" 重新開始；"end" 結束並致謝。

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { MessagingResponse } = require('twilio').twiml;

const app = express();
const PORT = process.env.PORT || 10000;

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. 'whatsapp:+14155238886'
const STEP_DELAY_MS = parseInt(process.env.STEP_DELAY_MS || '1000', 10); // 統一延遲
const USE_STATUS_CALLBACK = !!process.env.STATUS_CALLBACK_URL; // 是否使用回執節拍

app.use(bodyParser.urlencoded({ extended: false }));

// ---- 流程定義（檔名僅用於伺服器 log）----
const STEPS = [
  { title: '第一次權限檢查模組', file: 'modules/permission_check_first.js', ver: 'v0.1' },
  { title: '病人個人資料模組',   file: 'modules/patient_profile.js',        ver: 'v0.1' },
  { title: '第二次權限檢查模組', file: 'modules/permission_check_second.js', ver: 'v0.1' },
  { title: '病人病史模組',       file: 'modules/patient_history.js',         ver: 'v0.1' },
  { title: '問診系統模組',       file: 'modules/intake_questionnaire.js',    ver: 'v0.1' },
  { title: 'AI整理模組',         file: 'modules/ai_summary.js',              ver: 'v0.1' },
  { title: '匯出總結模組',       file: 'modules/export_summary.js',          ver: 'v0.1' },
];

// --- 極簡 Session（如需多實例請改 Firestore/Redis） ---
const sessions = new Map(); // key: userTo (whatsapp:+852...) -> { running, aborted, idx, queue }

function logStep(stepNo, step) {
  console.log(`[STEP ${stepNo}] ${step.title} | ${step.file} | ${step.ver}`);
}

// 執行模組：回傳「給病人看的」文字陣列；檔名/版本只寫 log
async function runStepMessages(stepNo, step) {
  logStep(stepNo, step);
  try {
    const mod = require(`./${step.file}`);
    const result = await mod({ stepNo, stepName: step.title });
    if (Array.isArray(result)) return result.map(s => sanitizePatientMsg(s, stepNo, step.title));
    if (typeof result === 'string') return [sanitizePatientMsg(result, stepNo, step.title)];
  } catch (_) {
    // 模組不存在或錯誤 → 用佔位訊息
  }
  return [formatPatientStep(stepNo, step.title)];
}

// 病人端顯示的乾淨格式
function formatPatientStep(stepNo, stepTitle) {
  return `【STEP ${stepNo}】${stepTitle}\n狀態：功能正在製作中…（系統會自動進入下一步）`;
}

// 若模組返回了較技術性的訊息，這裡可簡化成病人友善版本
function sanitizePatientMsg(raw, stepNo, stepTitle) {
  // 直接忽略任何包含「檔案：」「.js」「| v」的技術訊息
  if (/(檔案：|\.js| \| v)/i.test(raw)) return formatPatientStep(stepNo, stepTitle);
  return raw;
}

async function send(to, body) {
  const payload = { from: FROM, to, body };
  if (USE_STATUS_CALLBACK) payload.statusCallback = process.env.STATUS_CALLBACK_URL;
  return client.messages.create(payload);
}

function initSession(to) {
  const s = { running: false, aborted: false, idx: 0, queue: [] };
  sessions.set(to, s);
  return s;
}

async function startFlow(to) {
  const s = sessions.get(to) || initSession(to);
  if (s.running) return; // 已在跑，避免重入
  s.running = true; s.aborted = false; s.idx = 0; s.queue = [];

  const msgs = [
    '你好，我喺X醫生的預先問診系統，我哋現在開始啦😊',
    '（提示：任何時候輸入 restart 可重來；輸入 end 可結束）'
  ];
  for (let i = 0; i < STEPS.length; i++) {
    const arr = await runStepMessages(i + 1, STEPS[i]);
    msgs.push(...arr);
  }
  msgs.push('✅ 問診已完成，你的資料已傳送給醫生。謝謝你，祝你身體早日康復❤️');

  s.queue = msgs;
  // 先送第一則；剩下的由 delay 或 statusCallback 推進
  await send(to, s.queue[s.idx]);
  if (!USE_STATUS_CALLBACK) scheduleNext(to); // 若沒用回執，就用 delay 節拍
}

function scheduleNext(to) {
  const s = sessions.get(to);
  if (!s || s.aborted) return;
  setTimeout(async () => {
    const ss = sessions.get(to);
    if (!ss || ss.aborted) return;
    ss.idx += 1;
    if (ss.idx >= ss.queue.length) { ss.running = false; return; }
    await send(to, ss.queue[ss.idx]);
    if (!USE_STATUS_CALLBACK) scheduleNext(to);
  }, STEP_DELAY_MS);
}

function abortFlow(to) {
  const s = sessions.get(to);
  if (!s) return;
  s.aborted = true;
  s.running = false;
  s.queue = [];
}

// ---- Webhook：病人訊息 ----
app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();
  const incoming = (req.body.Body || '').trim().toLowerCase();
  const to = req.body.From; // 用戶端號碼（whatsapp:+852...）

  if (incoming === 'end') {
    abortFlow(to);
    twiml.message('🙏 謝謝，程序完結。');
    return res.type('text/xml').send(twiml.toString());
  }

  if (incoming === 'restart') {
    abortFlow(to);
    twiml.message('🔄 已收到 restart，流程將重新開始。');
    res.type('text/xml').send(twiml.toString());
    startFlow(to).catch(console.error);
    return;
  }

  // 其他文字：開始（若已在跑則回覆提示）
  const s = sessions.get(to);
  if (s && s.running) {
    twiml.message('流程正在進行中喔～如需重來輸入 restart；結束輸入 end。');
    return res.type('text/xml').send(twiml.toString());
  }
  twiml.message('✅ 已開始流程（如需重來輸入 restart；結束輸入 end）');
  res.type('text/xml').send(twiml.toString());
  startFlow(to).catch(console.error);
});

// ---- 回執 endpoint（可選）----
app.post('/status', express.urlencoded({ extended: false }), async (req, res) => {
  res.sendStatus(200);
  if (!USE_STATUS_CALLBACK) return;

  const status = (req.body.MessageStatus || '').toLowerCase(); // queued|sent|delivered|read...
  const to = req.body.To; // 我方的接收號碼（即病人端）
  if (!['sent', 'delivered'].includes(status)) return;

  const s = sessions.get(to);
  if (!s || s.aborted) return;

  // 推進下一則
  s.idx += 1;
  if (s.idx >= s.queue.length) { s.running = false; return; }
  await new Promise(r => setTimeout(r, STEP_DELAY_MS));
  await send(to, s.queue[s.idx]);
});

app.get('/', (_req, res) => {
  res.send('OK - preclinic flow is running (index.js v0.3.2, patient-clean output)');
});

app.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT} (index.js v0.3.2)`);
});