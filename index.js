const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));

// 用記憶體儲存使用者狀態（可用電話號碼當 key）
const sessionState = {}; // key: user phone, value: "active" or "ended"

app.post('/whatsapp', (req, res) => {
  const from = req.body.From;
  const body = req.body.Body.trim().toUpperCase(); // 統一大寫處理 OK
  let replyMsg = '';

  // 若已結束對話
  if (sessionState[from] === 'ended') {
    replyMsg = '你已完成對話，謝謝。';
  }

  // 若輸入 OK：結束對話
  else if (body === 'OK') {
    sessionState[from] = 'ended';
    replyMsg = '謝謝你，再見 👋';
  }

  // 有效輸入
  else if (body === '1') {
    replyMsg = 'A\n\n請輸入 1 或 2 或 3（輸入 OK 可結束）';
  } else if (body === '2') {
    replyMsg = 'B\n\n請輸入 1 或 2 或 3（輸入 OK 可結束）';
  } else if (body === '3') {
    replyMsg = 'Sze\n\n請輸入 1 或 2 或 3（輸入 OK 可結束）';
  }

  // 錯誤輸入提示
  else {
    replyMsg = '❌ 只可輸入 1 或 2 或 3（輸入 OK 可結束）';
  }

  // 回傳 Twilio XML 回覆
  res.set('Content-Type', 'text/xml');
  res.send(`
    <Response>
      <Message>${replyMsg}</Message>
    </Response>
  `);
});

app.listen(PORT, () => {
  console.log(`✅ WhatsApp 問診機器人運行中，port: ${PORT}`);
});






