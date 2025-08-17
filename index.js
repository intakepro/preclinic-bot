// File: index.js | v0.2 (Render Web Service + Twilio WhatsApp Webhook)
// 說明：常駐 Express 伺服器；接收 Twilio WhatsApp Webhook 並依序回覆 7 個流程訊息。
// 指令：any 時間輸入 "restart" 重新開始；"end" 結束並致謝。

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.urlencoded({ extended: false }));

// ---- 流程與（預期）模組檔名 ----
const STEPS = [
  { title: '第一次權限檢查模組', file: 'modules/permission_check_first.js' },
  { title: '病人個人資料模組',   file: 'modules/patient_profile.js' },
  { title: '第二次權限檢查模組', file: 'modules/permission_check_second.js' },
  { title: '病人病史模組',       file: 'modules/patient_history.js' },
  { title: '問診系統模組',       file: 'modules/intake_questionnaire.js' },
  { title: 'AI整理模組',         file: 'modules/ai_summary.js' },
  { title: '匯出總結模組',       file: 'modules/export_summary.js' },
];

// ---- 嘗試呼叫外部模組；若不存在則回傳佔位訊息 ----
async function runStepOrPlaceholder(stepNo, step) {
  try {
    const mod = require(`./${step.file}`);
    // 規格：外部模組若存在，回傳字串或字串陣列供訊息發送
    const result = await mod({ stepNo, stepName: step.title });
    if (Array.isArray(result)) return result;
    if (typeof result === 'string') return [result];
  } catch (e) {
    // 模組缺失或執行失敗，走佔位
  }
  // 佔位訊息（不依賴外部模組）
  return [
    `=== [STEP ${stepNo}] ${step.title} ===`,
    `檔案：${step.file} | v0.1`,
    `說明：這是佔位模組，功能正在製作中…（將繼續下一步）`,
  ];
}

// ---- 產生整段流程訊息（歡迎語 → 7 步 → 完成） ----
async function buildFullFlowMessages() {
  const messages = [];
  messages.push('你好，我喺X醫生的預先問診系統，我哋現在開始啦😊');
  for (let i = 0; i < STEPS.length; i++) {
    const stepMsgs = await runStepOrPlaceholder(i + 1, STEPS[i]);
    messages.push(...stepMsgs);
  }
  messages.push('✅ 問診已完成，你的資料已傳送給醫生。謝謝你，祝你身體早日康復❤️');
  return messages;
}

// ---- Twilio WhatsApp Webhook ----
app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();
  const incoming = (req.body.Body || '').trim().toLowerCase();

  // 指令：end
  if (incoming === 'end') {
    twiml.message('🙏 謝謝，程序完結。');
    return res.type('text/xml').send(twiml.toString());
  }

  // 指令：restart（或任何其它文字：預設視為開始）
  const msgs = await buildFullFlowMessages();
  // 小提醒
  msgs.unshift('（提示：任何時候輸入 restart 可重來；輸入 end 可結束）');

  // Twilio 允許同一回覆內多個 <Message>，這裡逐一加入
  msgs.forEach((m) => twiml.message(m));
  return res.type('text/xml').send(twiml.toString());
});

// ---- 健康檢查 ----
app.get('/', (_req, res) => {
  res.send('OK - preclinic flow is running (index.js v0.2)');
});

// ---- 啟動伺服器 ----
app.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT} (index.js v0.2)`);
});