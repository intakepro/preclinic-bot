// index.js
const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- 載入 7 個佔位模組（順序執行） ---
const steps = [
  require('./modules/step1_permission_check'),
  require('./modules/step2_patient_profile'),
  require('./modules/step3_permission_check_2'),
  require('./modules/step4_history_module'),
  require('./modules/step5_interview_module'),
  require('./modules/step6_ai_summary'),
  require('./modules/step7_export_summary'),
];

// 小工具：順序跑模組
async function runFlow(ctx) {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = `[STEP ${i + 1}]`;
    console.log(`${label} 開始模組執行 ───`);
    try {
      await step(ctx); // 每個模組只需 console.log，然後 return
      console.log(`${label} 完成，將自動進入下一步 👌`);
    } catch (err) {
      console.error(`${label} 發生錯誤：`, err);
      // 不中斷服務，但結束本次流程
      break;
    }
  }
  console.log('🎉 全部流程模組已經跑完（本次會話）');
}

// 健康檢查/首頁
app.get('/', (_req, res) => {
  res.send('Pre-clinic WhatsApp service is up. ✅');
});

// Twilio WhatsApp Webhook（接收病人訊息）
app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();

  // 你可以從 Twilio 取用者資訊／訊息
  const from = req.body.From || '';
  const body = (req.body.Body || '').trim();

  // 歡迎語（立即回覆 Twilio）
  const welcome =
    '你好，我喺X醫生的預先問診系統，我哋現在開始啦😊\n' +
    '系統已啟動流程，請稍等～';
  twiml.message(welcome);

  // 先回應 Twilio（避免超時），之後在背景順序跑 7 個模組（寫入 log）
  res.type('text/xml').send(twiml.toString());

  // 背景上下文，可放從 Twilio 取得的資料、Firestore 連線等
  const ctx = { from, body, ts: Date.now() };
  runFlow(ctx).catch(err => console.error('Flow error:', err));
});

// 保活：Render 期望有一個長駐 HTTP 服務
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🟢 Server is running on port ${PORT}`);
});

// 全域錯誤保護
process.on('unhandledRejection', err => {
  console.error('UnhandledRejection:', err);
});
process.on('uncaughtException', err => {
  console.error('UncaughtException:', err);
});