// index.js
// Version: v4.2.0
// 目標：除非模組等待使用者輸入，否則自動前進下一步（全流程皆適用）

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;

// === 模組匯入（依你目前檔名） ===
const { handleNameInput } = require('./modules/name_input');
const { handleAuth } = require('./modules/auth');
const { handleProfile } = require('./modules/profile');
const { handleHistory } = require('./modules/history'); // 你已改名為 history.js
const { handleInterview } = require('./modules/interview');
const { handleAiSummar } = require('./modules/ai_summar');
const { handleExport } = require('./modules/export');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// === 流程定義 ===
const STEPS = [
  { id: 1, key: 'name_input', handler: handleNameInput },
  { id: 2, key: 'auth',       handler: handleAuth },
  { id: 3, key: 'profile',    handler: handleProfile },
  { id: 4, key: 'history',    handler: handleHistory },
  { id: 5, key: 'interview',  handler: handleInterview },
  { id: 6, key: 'ai_summar',  handler: handleAiSummar },
  { id: 7, key: 'export',     handler: handleExport },
];

// === Session（記憶體；之後可換 Firestore）===
const sessions = new Map();
function getSession(phone) {
  if (!sessions.has(phone)) sessions.set(phone, { step: 0 });
  return sessions.get(phone);
}
function setStep(phone, step) { getSession(phone).step = step; }

// === UI ===
const welcomeText = () => '👋 歡迎使用 X 醫生問診系統，我哋而家開始啦⋯⋯😊';
const finishText  = () => '✅ 問診已完成，你的資料已傳送給醫生，祝你早日康復 ❤️';

// === 判斷結果：done=可前進；wait=需等待輸入 ===
// 模組建議回傳：
//  - { replied:true, done:true }     → 已處理且可前進
//  - { replied:true, wait:true }     → 已處理但要等使用者
// 相容舊旗標 autoNext:true 視同 done:true
function isDone(result) {
  return !!(result && (result.done === true || result.autoNext === true));
}
function isWait(result) {
  return !!(result && result.wait === true);
}

// === 取得步驟 ===
function getStepObj(i) { return STEPS.find(s => s.id === i) || null; }

// === Pipeline：在同一 webhook 內連續執行，直到遇到需要輸入的模組 ===
async function runPipeline({ req, res, from, initialMsg = '', startStep, twiml }) {
  setStep(from, startStep);
  let currentMsg = initialMsg;

  while (true) {
    const sess = getSession(from);
    const step = sess.step;

    // 全部完成
    if (step < 1 || step > STEPS.length) {
      const t = twiml || new MessagingResponse();
      t.message(finishText());
      return res.type('text/xml').send(t.toString());
    }

    const cur = getStepObj(step);
    if (!cur || typeof cur.handler !== 'function') {
      const t = twiml || new MessagingResponse();
      t.message(`⚠️ 流程錯誤：步驟 ${step} 未接線。`);
      return res.type('text/xml').send(t.toString());
    }

    // 呼叫目前模組（若傳入 twiml，模組應直接把訊息 append 到同一 TwiML）
    const result = await cur.handler({ req, res, from, msg: currentMsg, twiml });

    // 之後的自動前進不再把使用者輸入傳遞下去
    currentMsg = '';

    if (isDone(result)) {
      // 立即前進下一步（不等使用者）
      setStep(from, step + 1);
      continue; // 繼續 while，嘗試下一個模組
    }

    // 若模組需要等待輸入（或沒有回 done），就停止 pipeline
    // - twiml 存在 → 這個迴合統一由 index 送出
    // - twiml 不存在 → 一般由模組已經 res.send()；若沒有則 204
    if (twiml) return res.type('text/xml').send(twiml.toString());
    if (!res.headersSent) return res.status(204).end();
    return;
  }
}

// === Webhook ===
app.post('/whatsapp', async (req, res) => {
  const from = (req.body.From || '').replace(/^whatsapp:/i, '');
  const body = (req.body.Body || '').trim();
  const sess = getSession(from);

  // restart → 回到未開始
  if (/^restart$/i.test(body)) {
    setStep(from, 0);
  }

  // 初次或重置：同回合送「歡迎 + 模組1第一題」，然後流水線自動跑下去直到遇到等待輸入的模組
  if (sess.step === 0) {
    const twiml = new MessagingResponse();
    twiml.message(welcomeText());
    return runPipeline({ req, res, from, initialMsg: '', startStep: 1, twiml });
  }

  // 一般：把使用者輸入交給當前步驟，然後繼續自動前進直到遇到要等輸入的模組
  return runPipeline({ req, res, from, initialMsg: body, startStep: sess.step, twiml: null });
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor flow server running. v4.2.0'));

// 啟動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));