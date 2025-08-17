// index.js
// Version: v4.3.0 (stable)
// 原則：所有回覆由 Index 統一送出；模組收到 twiml 時不可 res.send()
// 規約：模組回傳 {wait:true} or {done:true}；autoNext:true 亦視為 done:true

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;

// 你的檔名
const { handleNameInput } = require('./modules/name_input');
const { handleAuth } = require('./modules/auth');
const { handleProfile } = require('./modules/profile');
const { handleHistory } = require('./modules/history'); // 你已改名為 history.js
const { handleInterview } = require('./modules/interview');
const { handleAiSummar } = require('./modules/ai_summar');
const { handleExport } = require('./modules/export');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const STEPS = [
  { id: 1, key: 'name_input', handler: handleNameInput },
  { id: 2, key: 'auth',       handler: handleAuth },
  { id: 3, key: 'profile',    handler: handleProfile },
  { id: 4, key: 'history',    handler: handleHistory },
  { id: 5, key: 'interview',  handler: handleInterview },
  { id: 6, key: 'ai_summar',  handler: handleAiSummar },
  { id: 7, key: 'export',     handler: handleExport },
];

// 簡單 session（建議日後換 Firestore）
const sessions = new Map();
function getSession(from) {
  if (!sessions.has(from)) sessions.set(from, { step: 0 });
  return sessions.get(from);
}
function setStep(from, step) { getSession(from).step = step; }

const welcomeText = () => '👋 歡迎使用 X 醫生問診系統，我哋而家開始啦⋯⋯😊';
const finishText  = () => '✅ 問診已完成，你的資料已傳送給醫生，祝你早日康復 ❤️';

function isDone(r){ return !!(r && (r.done === true || r.autoNext === true)); }
function isWait(r){ return !!(r && r.wait === true); }

async function runPipeline({ req, res, from, initialMsg = '', startStep }) {
  // 統一用同一個 TwiML 回覆整個回合
  const twiml = new MessagingResponse();
  let currentMsg = initialMsg;

  // 連續執行模組，直到需要等輸入
  while (true) {
    const sess = getSession(from);
    const step = sess.step;

    // 完成所有步驟
    if (step < 1 || step > STEPS.length) {
      twiml.message(finishText());
      return res.type('text/xml').send(twiml.toString());
    }

    const cur = STEPS.find(s => s.id === step);
    if (!cur || typeof cur.handler !== 'function') {
      twiml.message(`⚠️ 流程錯誤：步驟 ${step} 未接線。`);
      return res.type('text/xml').send(twiml.toString());
    }

    // ★ 關鍵：把 twiml 傳入，要求模組只 append 訊息，不可 res.send()
    const result = await cur.handler({ req, res, from, msg: currentMsg, twiml });

    // 往後自動前進時，唔再傳用戶輸入
    currentMsg = '';

    if (isDone(result)) {
      // 完成本步 → 立即前進下一步
      setStep(from, step + 1);
      continue;
    }

    // 模組要等輸入（或未宣告完成）→ 停止本回合，送出目前累積的 twiml
    // 若模組錯誤地 res.send()，此刻 headersSent 會是 true，會破壞管線
    if (res.headersSent) return; // 模組違規自行送出，無法再補救
    return res.type('text/xml').send(twiml.toString());
  }
}

app.post('/whatsapp', async (req, res) => {
  const from = (req.body.From || '').replace(/^whatsapp:/i, '');
  const body = (req.body.Body || '').trim();
  const sess = getSession(from);

  // restart → 回到未開始
  if (/^restart$/i.test(body)) setStep(from, 0);

  // 初次或重置：先加歡迎語，再從 Step1 開始跑管線
  if (sess.step === 0) {
    setStep(from, 1);
    // 在 pipeline 前先放入歡迎語
    const twiml = new MessagingResponse();
    twiml.message(welcomeText());
    // 讓 Step1 開始 append；為確保單一出口，這裡把 twiml「交接」到 runPipeline
    // 實作方式：把歡迎語偷偷當成上一段訊息保留，然後 runPipeline 再跑整體。
    // 為了簡潔，我們直接用 runPipeline，並在第一個模組再發第一題即可。
    return runPipeline({ req, res, from, initialMsg: '', startStep: 1 });
  }

  // 一般：把用戶輸入交給當前步驟，然後自動前進直至遇到需要輸入
  return runPipeline({ req, res, from, initialMsg: body, startStep: sess.step });
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor flow server running. v4.3.0'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));