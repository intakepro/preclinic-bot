// File: index.js | v0.3 (sequential messages via Twilio REST)
// 說明：Webhook 只觸發流程；伺服器用 Twilio REST API 依序發送每一步訊息（含歡迎語）。
// 指令：任何時候輸入 "restart" 重新開始；"end" 立即結束並致謝。

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 10000;

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. 'whatsapp:+14155238886'
const STEP_DELAY_MS = parseInt(process.env.STEP_DELAY_MS || '800', 10);

// --- 流程定義 ---
const STEPS = [
  { title: '第一次權限檢查模組', file: 'modules/permission_check_first.js' },
  { title: '病人個人資料模組',   file: 'modules/patient_profile.js' },
  { title: '第二次權限檢查模組', file: 'modules/permission_check_second.js' },
  { title: '病人病史模組',       file: 'modules/patient_history.js' },
  { title: '問診系統模組',       file: 'modules/intake_questionnaire.js' },
  { title: 'AI整理模組',         file: 'modules/ai_summary.js' },
  { title: '匯出總結模組',       file: 'modules/export_summary.js' },
];

// --- 最簡 Session（用電話號碼作 key；量大時改 Firestore/Redis） ---
const sessions = new Map(); // phone -> { running: boolean, aborted: boolean }

async function runStepOrPlaceholder(stepNo, step) {
  try {
    const mod = require(`./${step.file}`);
    const result = await mod({ stepNo, stepName: step.title });
    if (Array.isArray(result)) return result;
    if (typeof result === 'string') return [result];
  } catch (_) {
    // 模組缺失或錯誤 → 走佔位
  }
  return [
    `=== [STEP ${stepNo}] ${step.title} ===`,
    `檔案：${step.file} | v0.1`,
    `說明：這是佔位模組，功能正在製作中…（將繼續下一步）`,
  ];
}

async function send(to, body) {
  return client.messages.create({ from: FROM, to, body });
}

async function runFlowSequentially(to) {
  const s = sessions.get(to) || { running: false, aborted: false };
  if (s.running) return; // 已在跑，避免重入
  s.running = true; s.aborted = false;
  sessions.set(to, s);

  // 歡迎語
  await send(to, '你好，我喺X醫生的預先問診系統，我哋現在開始啦😊');
  await send(to, '（提示：任何時候輸入 restart 可重來；輸入 end 可結束）');

  for (let i = 0; i < STEPS.length; i++) {
    if (s.aborted) break;
    const msgs = await runStepOrPlaceholder(i + 1, STEPS[i]);
    for (const m of msgs) {
      if (s.aborted) break;
      await send(to, m);
      await new Promise(r => setTimeout(r, STEP_DELAY_MS));
    }
    await new Promise(r => setTimeout(r, STEP_DELAY_MS));
  }

  if (!s.aborted) {
    await send(to, '✅ 問診已完成，你的資料已傳送給醫生。謝謝你，祝你身體早日康復❤️');
  }
  s.running = false;
}

function abortFlow(to) {
  const s = sessions.get(to);
  if (s) s.aborted = true;
}

// --------- Webhook ----------
app.use(bodyParser.urlencoded({ extended: false }));

app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();
  const incoming = (req.body.Body || '').trim().toLowerCase();
  const to = req.body.From; // 使用者電話號（whatsapp:+852xxxx）
  // const ourNumber = req.body.To; // 我方發信號，可用來做路由

  if (incoming === 'end') {
    abortFlow(to);
    twiml.message('🙏 謝謝，程序完結。');
    return res.type('text/xml').send(twiml.toString());
  }

  if (incoming === 'restart') {
    abortFlow(to); // 停掉舊流程
    twiml.message('🔄 已收到 restart，流程將重新開始。');
    res.type('text/xml').send(twiml.toString());
    // 重新啟動新流程（不要卡住 Webhook）
    runFlowSequentially(to).catch(console.error);
    return;
  }

  // 其他任何訊息都視為「開始/繼續」
  twiml.message('✅ 已開始流程（如需重來輸入 restart；結束輸入 end）');
  res.type('text/xml').send(twiml.toString());
  runFlowSequentially(to).catch(console.error);
});

app.get('/', (_req, res) => {
  res.send('OK - preclinic flow is running (index.js v0.3)');
});

app.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT} (index.js v0.3)`);
});