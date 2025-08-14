// index.js
// 簡易 WhatsApp 問診流程控制器（6 個順序步驟，先用佔位模組，按 0 進入下一步）
//
// 依賴：express、body-parser、twilio
// 安裝：npm i express body-parser twilio
//
// 啟動：node index.js
// Webhook 路徑：POST /whatsapp
//
// 備註：目前使用「記憶體 Session」保存每個電話的流程步驟（適合本機測試）。
//       未來要上線可改成 Firestore 或你既有的儲存方案。

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ====== 流程步驟定義 ======
const STEPS = [
  { id: 1, key: 'auth',      name: '病人問診權限檢查模組' },
  { id: 2, key: 'profile',   name: '讀取病人資料模組'     },
  { id: 3, key: 'history',   name: '讀取病人病史模組'     },
  { id: 4, key: 'interview', name: '問診系統模組'         },
  { id: 5, key: 'ai_summar', name: 'AI整理模組'           },
  { id: 6, key: 'export',    name: '匯出總結模組'         },
];

// 記憶體 Session：{ [fromPhone]: { stepIndex: 0..5 } }
const sessions = new Map();

// 取得或建立 Session
function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, { stepIndex: 0 }); // 從第 1 步（index 0）開始
  }
  return sessions.get(from);
}

// 產生佔位提示訊息
function placeholderMessage(step) {
  return [
    `🔧 【${step.id}. ${step.name}】`,
    `該模組製作中，請輸入「0」跳去下一個流程。`,
    `（未來你完成此模組後，把這裡替換為實際的函式呼叫即可）`
  ].join('\n');
}

// 進入下一步：若已是最後一步，提示完成並重置或等待指令
function goNext(session) {
  if (session.stepIndex < STEPS.length - 1) {
    session.stepIndex += 1;
    return null; // 正常前進
  } else {
    // 已完成全部步驟
    session.stepIndex = STEPS.length - 1; // 保持在最後一步
    return '✅ 全部 6 個流程已完成。\n輸入「restart」可由第 1 步重新開始。';
  }
}

// 回到第一步
function restart(session) {
  session.stepIndex = 0;
}

// 首次歡迎文案
function welcomeText() {
  return [
    '👋 歡迎使用預先問診流程（Demo 版本）',
    '此版本會依序呼叫 6 個模組（目前為佔位畫面）。',
    '在每個步驟輸入「0」即可跳至下一個流程。',
    '輸入「restart」可隨時回到第 1 步；輸入「help」查看指令。',
  ].join('\n');
}

// 說明文案
function helpText() {
  const lines = STEPS.map(s => `  ${s.id}. ${s.name}`);
  return [
    '📖 指令說明：',
    '  0        ➝ 跳到下一個流程',
    '  restart  ➝ 回到第 1 步',
    '  help     ➝ 顯示此說明',
    '',
    '📌 流程步驟：',
    ...lines
  ].join('\n');
}

// WhatsApp Webhook
app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();

  const from = req.body.From || 'unknown';
  const msg  = (req.body.Body || '').trim();

  const session = getSession(from);

  // 指令處理
  if (/^restart$/i.test(msg)) {
    restart(session);
    twiml.message(welcomeText() + '\n\n' + placeholderMessage(STEPS[session.stepIndex]));
    return res.type('text/xml').send(twiml.toString());
  }

  if (/^help$/i.test(msg)) {
    twiml.message(helpText());
    return res.type('text/xml').send(twiml.toString());
  }

  // 流程控制
  const currentStep = STEPS[session.stepIndex];

  if (msg === '0') {
    const doneMessage = goNext(session);
    if (doneMessage) {
      // 全部完成
      twiml.message(doneMessage);
      return res.type('text/xml').send(twiml.toString());
    }
    // 邁入下一步
    const nextStep = STEPS[session.stepIndex];
    twiml.message(placeholderMessage(nextStep));
    return res.type('text/xml').send(twiml.toString());
  }

  // 非 0 的一般輸入：回覆目前步驟的佔位提示
  // （未來可在這裡加入對應模組的實際處理）
  twiml.message(
    // 第一次互動也給個歡迎說明
    (msg === '' ? welcomeText() + '\n\n' : '') + placeholderMessage(currentStep)
  );

  return res.type('text/xml').send(twiml.toString());
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor AI flow server running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});













