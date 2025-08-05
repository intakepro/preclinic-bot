const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// 模擬使用者對話狀態（開發版可用，未連接 Firestore）
const userState = {};

app.use(express.urlencoded({ extended: false }));

app.post('/whatsapp', (req, res) => {
  const from = req.body.From; // 使用者電話號碼
  const body = req.body.Body.trim(); // 去除多餘空白
  let replyMsg = '';

  if (!userState[from]) {
    // 若是第一次對話或未在狀態中
    userState[from] = 'WAITING_INPUT';
    replyMsg = '請你輸入1至3';
  } else {
    // 使用者已經在輸入階段
    switch (body) {
      case '1':
        replyMsg = 'A';
        delete userState[from];
        break;
      case '2':
        replyMsg = 'B';
        delete userState[from];
        break;
      case '3':
        replyMsg = 'C';
        delete userState[from];
        break;
      default:
        replyMsg = '我只接受輸入1至3';
    }
  }

  // 回傳 TwiML XML 格式的回覆
  res.set('Content-Type', 'text/xml');
  res.send(`
    <Response>
      <Message>${replyMsg}</Message>
    </Response>
  `);
});

app.listen(PORT, () => {
  console.log(`✅ 問診系統機器人已啟動於 port ${PORT}`);
});









