// index.js
// WhatsApp Webhook（Twilio）＋ 病史模組整合示例

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const { handleHistoryModule } = require('./modules/history_module');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ====== （示例）整體流程步驟（你可改為你現有的）======
const STEPS = [
  { id: 1, key: 'name_input', name: '輸入病人名字模組' },
  { id: 2, key: 'auth',       name: '病人問診權限檢查模組' },
  { id: 3, key: 'profile',    name: '讀取病人資料模組' },
  { id: 4, key: 'history',    name: '病史模組' },                // ★ 我們現在示例用這一步
  { id: 5, key: 'interview',  name: '問診主訴/現病史模組' },
  { id: 6, key: 'ros',        name: '系統回顧模組' },
  { id: 7, key: 'summary',    name: '總結/交付給醫師模組' }
];

// （示例）簡化的全域使用者步驟狀態（正式上線建議也放 Firestore）
const userStep = {}; // { [from]: number }

function getCurrentStepKey(from) {
  const idx = userStep[from] ?? 4; // Demo：從第 4 步（history）開始
  return STEPS.find(s => s.id === idx)?.key || 'history';
}

function advanceStep(from) {
  const current = userStep[from] ?? 4;
  userStep[from] = Math.min(current + 1, STEPS.length);
}

async function stateRouter({ from, body }) {
  const key = getCurrentStepKey(from);

  if (key === 'history') {
    const reply = await handleHistoryModule({ from, body });

    // 若模組回覆包含「進入下一個模組」關鍵字，就前進一步
    if (reply.includes('進入下一個模組')) {
      advanceStep(from);
    }
    return reply;
  }

  // 其他模組僅示意
  return `目前在模組：${key}\n（此模組尚未實作；請輸入任意文字回到病史模組示範）`;
}

app.post('/whatsapp', async (req, res) => {
  const from = (req.body.From || '').replace(/^whatsapp:/, '').trim();
  const body = (req.body.Body || '').trim();

  const twiml = new MessagingResponse();
  try {
    const replyMsg = await stateRouter({ from, body });
    twiml.message(replyMsg);
  } catch (err) {
    console.error('Error:', err);
    twiml.message('系統忙碌或發生錯誤，請稍後再試 🙏');
  }

  res.type('text/xml').send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ WhatsApp 問診機器人運行中，port: ${PORT}`);
});





