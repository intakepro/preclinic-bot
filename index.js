// src/index.js
// WhatsApp 問診 7 步驟 Demo（第 1 步接入 name_input；第 4 步接入病史模組）
// ++ 加入：模組呼叫超時保護、單次回覆保險、詳細日誌

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const { handleNameInput } = require('./modules/name_input');

// 病史模組（記憶體版）
const { createHistoryModule } = require('./modules/history');
const { handle: handleHistory } = createHistoryModule();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ---- 可調參數 ----
const MODULE_TIMEOUT_MS = parseInt(process.env.MODULE_TIMEOUT_MS || '8000', 10);
const EXIT_ON_COMPLETE = (process.env.EXIT_ON_COMPLETE || 'true').toLowerCase() === 'true';

// ====== 流程步驟定義（7 個）======
const STEPS = [
  { id: 1, key: 'name_input', name: '輸入病人名字模組' },
  { id: 2, key: 'auth',       name: '病人問診權限檢查模組' },
  { id: 3, key: 'profile',    name: '讀取病人資料模組' },
  { id: 4, key: 'history',    name: '讀取病人病史模組' },
  { id: 5, key: 'interview',  name: '問診系統模組' },
  { id: 6, key: 'ai_summar',  name: 'AI整理模組' },
  { id: 7, key: 'export',     name: '匯出總結模組' },
];

// 記憶體 Session：{ [fromPhone]: { stepIndex, selectedPatient? } }
const sessions = new Map();
function getSession(from) {
  if (!sessions.has(from)) sessions.set(from, { stepIndex: 0, selectedPatient: null });
  return sessions.get(from);
}

// ---- 小工具：保證只回覆一次 ----
function respondOnce(res) {
  let sent = false;
  return (twiml) => {
    if (sent) return;
    sent = true;
    res.type('text/xml').send(twiml.toString());
  };
}

// ---- 小工具：模組超時保護 ----
function withTimeout(promise, ms, onTimeoutMsg) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      const err = new Error('MODULE_TIMEOUT');
      err._timeoutMessage = onTimeoutMsg;
      reject(err);
    }, ms);
    promise.then((v) => { clearTimeout(to); resolve(v); })
           .catch((e) => { clearTimeout(to); reject(e); });
  });
}

function placeholderMessage(step) {
  return [
    `🔧 【${step.id}. ${step.name}】`,
    `該模組製作中，請輸入「0」跳去下一個流程。`,
    `（未來你完成此模組後，把這裡替換為實際的函式呼叫即可）`
  ].join('\n');
}
function welcomeText() {
  return [
    '👋 歡迎使用預先問診流程（Demo 版本）',
    '此版本會依序呼叫 7 個模組。',
    '第 1 步已整合「輸入病人名字模組」。',
    '第 4 步已整合「病史模組」。',
    '其餘為佔位畫面。',
    '（在第 1 步中，數字 0 代表「上一頁」；在第 2、3、5～7 步中，數字 0 代表「前進」。）',
    '輸入「restart」可隨時回到第 1 步；輸入「help」查看指令。'
  ].join('\n');
}
function helpText() {
  const lines = STEPS.map(s => `  ${s.id}. ${s.name}`);
  return [
    '📖 指令說明：',
    '  0        ➝ 在第 1 步：回上一頁；在第 2、3、5～7 步：跳到下一個流程',
    '  restart  ➝ 回到第 1 步',
    '  help     ➝ 顯示此說明',
    '',
    '📌 流程步驟：',
    ...lines
  ].join('\n');
}

// Webhook（確保 Twilio 指向 POST /whatsapp）
app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();
  const send = respondOnce(res);

  const from = (req.body.From || '').toString();
  const msg  = (req.body.Body || '').toString().trim();

  const session = getSession(from);
  const currentStep = STEPS[session.stepIndex];

  console.log(`[IN] from=${from} step=${currentStep.key} msg="${msg}"`);

  // 指令：restart / help（任何步驟有效）
  if (/^restart$/i.test(msg)) {
    session.stepIndex = 0;
    twiml.message(welcomeText());
    return send(twiml);
  }
  if (/^help$/i.test(msg)) {
    twiml.message(helpText());
    return send(twiml);
  }

  // 第 1 步：name_input 模組（→ 你自己的模組需「快速回傳」或「自行回覆」）
  if (currentStep.key === 'name_input') {
    try {
      // 用超時包住，避免無限等待
      const result = await withTimeout(
        Promise.resolve(handleNameInput({
          req, res, from, msg,
          onComplete: ({ phone, patientId, name }) => {
            session.selectedPatient = { phone, patientId, name };
          },
          advanceNext: () => { session.stepIndex = 1; } // 進到第 2 步
        })),
        MODULE_TIMEOUT_MS,
        '⚠️ 名字輸入模組回應逾時，請再輸入一次或稍後重試。'
      );

      // 約定：若模組已自己回覆（例如直接 res.send TwiML），回傳 { replied: true }
      if (result && result.replied) {
        console.log('[name_input] replied by module');
        return; // 不可再回覆
      }

      // 否則由外層回覆一條「成功接收」的訊息（避免用戶覺得卡住）
      console.log('[name_input] outer reply');
      twiml.message('✅ 已收到你的輸入。請按畫面指示繼續。');
      return send(twiml);

    } catch (e) {
      console.error('[name_input] error:', e);
      twiml.message(e._timeoutMessage || '名字輸入模組暫時無法服務，請稍後再試 🙏');
      return send(twiml);
    }
  }

  // ★ 第 4 步：病史模組（本步通常有多輪互動，不採「0 前進」直跳）
  if (currentStep.key === 'history') {
    try {
      const reply = await withTimeout(
        Promise.resolve(handleHistory({ from, body: msg })), // 你的 history 模組需快速回覆字串
        MODULE_TIMEOUT_MS,
        '⚠️ 病史模組回應逾時，請再輸入一次或稍後重試。'
      );
      twiml.message(reply || '（空訊息）');
      return send(twiml);
    } catch (e) {
      console.error('[history] error:', e);
      twiml.message(e._timeoutMessage || '病史模組暫時無法服務，請稍後再試 🙏');
      return send(twiml);
    }
  }

  // 第 2、3、5～7 步：佔位邏輯（0 前進）
  if (msg === '0') {
    if (session.stepIndex < STEPS.length - 1) {
      session.stepIndex += 1;
      const nextStep = STEPS[session.stepIndex];
      console.log(`[FLOW] advance to step=${nextStep.key}`);

      if (nextStep.key === 'history') {
        twiml.message('🩺 進入【病史】模組。\n（本步驟不支援 0 跳過，請按畫面指示回覆選項）');
        return send(twiml);
      }
      twiml.message(placeholderMessage(nextStep));
      return send(twiml);
    } else {
      twiml.message('✅ 問診已完成，你的資料已傳送給醫生，謝謝你，祝你身體早日康復❤️');
      send(twiml);
      if (EXIT_ON_COMPLETE) {
        setTimeout(() => { process.exit(0); }, 1000);
      }
      return;
    }
  }

  // 其他情況：回覆佔位提示或歡迎＋佔位
  twiml.message(
    (msg === '' ? welcomeText() + '\n\n' : '') + placeholderMessage(currentStep)
  );
  return send(twiml);
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor AI flow server running.'));

// 啟動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});