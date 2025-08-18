// index.js
// Version: v6.0.0
// 流程：歡迎語 → 步驟1~7（每步都要求使用者回覆 z 才前進）→ 結語
// 原則：Index 只負責排程與串接；每步的提示與完成判斷由各模組自己處理

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;

// === 模組匯入（佔位版） ===
const { handleNameInput } = require('./modules/name_input');
const { handleAuth }      = require('./modules/auth');
const { handleProfile }   = require('./modules/profile');
const { handleHistory }   = require('./modules/history'); // 你已改名為 history.js
const { handleInterview } = require('./modules/interview');
const { handleAiSummar }  = require('./modules/ai_summar');
const { handleExport }    = require('./modules/export');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// === 步驟定義 ===
const STEPS = [
  { id: 1, key: 'name_input', name: '輸入病人名字模組', handler: handleNameInput },
  { id: 2, key: 'auth',       name: '病人問診權限檢查模組', handler: handleAuth },
  { id: 3, key: 'profile',    name: '讀取病人資料模組',   handler: handleProfile },
  { id: 4, key: 'history',    name: '讀取病人病史模組',   handler: handleHistory },
  { id: 5, key: 'interview',  name: '問診系統模組',       handler: handleInterview },
  { id: 6, key: 'ai_summar',  name: 'AI 整理模組',        handler: handleAiSummar },
  { id: 7, key: 'export',     name: '匯出總結模組',        handler: handleExport },
];

// === Session（記憶體） ===
const sessions = new Map();
function getSession(phone) {
  if (!sessions.has(phone)) sessions.set(phone, { step: 0 });
  return sessions.get(phone);
}
function setStep(phone, step) { getSession(phone).step = step; }

// === UI ===
const welcomeText = () => '👋 歡迎使用 X 醫生問診系統，我哋而家開始啦⋯⋯😊';
const finishText  = () => '✅ 問診已完成，你的資料已傳送給醫生，謝謝你，祝你早日康復 ❤️';

// === 呼叫某一步的模組 ===
// 模組介面：async handleX({ msg }) -> { text: string, done: boolean }
async function runStep(stepDef, msg) {
  const fn = stepDef.handler;
  const result = await fn({ msg });
  if (!result || typeof result.text !== 'string') {
    return { text: `👉 第 ${stepDef.id} 步：${stepDef.name}\n（製作中）請按 z 進入下一步。`, done: false };
  }
  return result;
}

// === Webhook ===
app.post('/whatsapp', async (req, res) => {
  const from = (req.body.From || '').replace(/^whatsapp:/i, '');
  const body = (req.body.Body || '').trim();
  const sess = getSession(from);
  const twiml = new MessagingResponse();

  // restart：重置流程
  if (/^restart$/i.test(body)) {
    setStep(from, 0);
  }

  // 首次 / 已重置：先出歡迎語，要求回覆 z 開始 → 進入 Step1
  if (sess.step === 0) {
    // 這一步也需要使用者回覆（按你的新原則）
    if (!/^z$/i.test(body)) {
      twiml.message(`${welcomeText()}\n\n請按 z 開始第 1 步。`);
      return res.type('text/xml').send(twiml.toString());
    }
    setStep(from, 1);
  }

  // 正常流程：取目前步驟
  const stepDef = STEPS.find(s => s.id === sess.step);

  // 全部完成
  if (!stepDef) {
    twiml.message(finishText());
    return res.type('text/xml').send(twiml.toString());
  }

  // 呼叫當前模組
  const result = await runStep(stepDef, body);
  if (result.done) {
    // 前進到下一步，並提示下一步需要回覆
    setStep(from, sess.step + 1);
    const next = STEPS.find(s => s.id === getSession(from).step);
    if (next) {
      // 下一步也要等使用者回覆，所以只顯示「正在進入下一步，請按 z 繼續」的提示
      twiml.message(`✅ 已完成：第 ${stepDef.id} 步「${stepDef.name}」。\n👉 進入第 ${next.id} 步「${next.name}」。\n請按 z 繼續。`);
    } else {
      twiml.message(finishText());
    }
    return res.type('text/xml').send(twiml.toString());
  }

  // 未完成（需要使用者回覆）→ 顯示本步提示（要求按 z）
  twiml.message(result.text);
  return res.type('text/xml').send(twiml.toString());
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor flow server running. v6.0.0'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));