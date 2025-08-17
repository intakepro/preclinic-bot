/**
 * index.js
 * Version: v4.0.0
 * 功能：WhatsApp 問診主流程
 * 流程：
 *   1. 顯示歡迎語
 *   2. 自動呼叫模組 1 → 7
 *   3. 各模組完成後自動返回 index
 *   4. 完成後輸出結語
 */

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;

// ====== 模組匯入 ======
const { handleNameInput } = require('./modules/name_input');
const { handleAuth } = require('./modules/auth');
const { handleProfile } = require('./modules/profile');
const { handleHistory } = require('./modules/history');
const { handleInterview } = require('./modules/interview');
const { handleAiSummar } = require('./modules/ai_summar');
const { handleExport } = require('./modules/export');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ====== 流程步驟定義 ======
const STEPS = [
  { id: 1, key: 'name_input', handler: handleNameInput },
  { id: 2, key: 'auth',       handler: handleAuth },
  { id: 3, key: 'profile',    handler: handleProfile },
  { id: 4, key: 'history',    handler: handleHistory },
  { id: 5, key: 'interview',  handler: handleInterview },
  { id: 6, key: 'ai_summar',  handler: handleAiSummar },
  { id: 7, key: 'export',     handler: handleExport },
];

// ====== 記憶體 Session ======
// 線上建議換成 Firestore
const sessions = {};

// ====== 主流程控制 ======
function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = { step: 0 }; // step=0 → 還沒開始
  }
  return sessions[phone];
}

function setSessionStep(phone, step) {
  if (!sessions[phone]) sessions[phone] = {};
  sessions[phone].step = step;
}

// ====== WhatsApp Webhook ======
app.post('/whatsapp', async (req, res) => {
  const from = (req.body.From || '').replace('whatsapp:', '');
  const msg = (req.body.Body || '').trim();

  const twiml = new MessagingResponse();

  let session = getSession(from);

  // 初始狀態 → 顯示歡迎語，並自動進入模組 1
  if (session.step === 0) {
    twiml.message('👋 歡迎使用 X 醫生問診系統，我哋而家開始啦⋯⋯😊');
    res.type('text/xml').send(twiml.toString());
    setSessionStep(from, 1); // 下一個請求會跑到模組 1
    return;
  }

  // 已在流程中 → 執行當前模組
  const step = session.step;
  const current = STEPS.find(s => s.id === step);

  if (!current) {
    twiml.message('⚠️ 系統錯誤：流程不存在。');
    res.type('text/xml').send(twiml.toString());
    return;
  }

  try {
    const result = await current.handler({
      req,
      res,
      from,
      msg,
      onComplete: () => {}, // 可用於回傳資料
      advanceNext: () => {
        // 模組完成 → 自動進入下一步
        const nextStep = step + 1;
        if (nextStep <= STEPS.length) {
          setSessionStep(from, nextStep);
        } else {
          setSessionStep(from, -1); // 結束
        }
      }
    });

    // 如果模組完成（done=true），直接切到下一步
    if (result && result.done) {
      const nextStep = step + 1;
      if (nextStep <= STEPS.length) {
        setSessionStep(from, nextStep);
      } else {
        setSessionStep(from, -1);
        const endTwiml = new MessagingResponse();
        endTwiml.message('✅ 問診已完成，祝你早日康復！');
        res.type('text/xml').send(endTwiml.toString());
      }
    }

  } catch (err) {
    console.error('[index] error:', err);
    twiml.message('系統發生錯誤，請稍後再試。');
    res.type('text/xml').send(twiml.toString());
  }
});

// ====== 啟動 ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});